#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use codex_mcp_platform::{
    cloudflare,
    runtime::{self, Controller},
    secure,
    settings::{Input, Settings},
    updates,
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::{
    Manager, State,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};
use tauri_plugin_notification::NotificationExt;
type Reply<T> = Result<T, String>;
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
struct App {
    controller: Controller,
    settings: tokio::sync::Mutex<Settings>,
    update: tokio::sync::Mutex<Option<updates::Manifest>>,
    login: AtomicBool,
    quitting: AtomicBool,
}
#[tauri::command]
async fn state(app: State<'_, Arc<App>>, handle: tauri::AppHandle) -> Reply<Value> {
    Ok(
        json!({"settings":app.settings.lock().await.view(),"connection":app.controller.view(),"version":handle.package_info().version.to_string(),"update":app.update.lock().await.as_ref().map(|u|json!({"version":u.version}))}),
    )
}
#[tauri::command]
async fn save_settings(input: Input, app: State<'_, Arc<App>>) -> Reply<Value> {
    if app.controller.view()["running"] == true {
        return Err("Stop the connection before changing settings".into());
    }
    let mut settings = app.settings.lock().await;
    settings
        .update(input, &app.controller.install)
        .map_err(error)?;
    Ok(settings.view())
}
#[tauri::command]
async fn generate_password(app: State<'_, Arc<App>>) -> Reply<Value> {
    use rand::RngCore;
    let mut random = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut random);
    let password = random
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let mut s = app.settings.lock().await;
    s.password = secure::protect(password.as_bytes()).map_err(error)?;
    s.save().map_err(error)?;
    Ok(s.view())
}
#[tauri::command]
async fn copy_password(app: State<'_, Arc<App>>) -> Reply<()> {
    let s = app.settings.lock().await;
    let password = secure::unprotect(&s.password).map_err(error)?;
    if password.is_empty() {
        return Err("Save an MCP password first".into());
    }
    #[cfg(windows)]
    clipboard_win::set_clipboard_string(std::str::from_utf8(&password).map_err(error)?)
        .map_err(error)?;
    Ok(())
}
#[tauri::command]
async fn account_status(app: State<'_, Arc<App>>) -> Reply<Value> {
    runtime::account(&app.controller.install, false)
        .await
        .map_err(error)
}
#[tauri::command]
async fn account_login(app: State<'_, Arc<App>>) -> Reply<Value> {
    if app.login.swap(true, Ordering::SeqCst) {
        return Err("A sign-in window is already open".into());
    }
    let result = runtime::account(&app.controller.install, true).await;
    app.login.store(false, Ordering::SeqCst);
    result.map_err(error)?;
    runtime::account(&app.controller.install, false)
        .await
        .map_err(error)
}
#[tauri::command]
async fn sandbox_check(app: State<'_, Arc<App>>) -> Reply<Value> {
    let s = app.settings.lock().await.clone();
    app.controller.probe(s).await.map_err(error)
}
#[tauri::command]
async fn start_connection(app: State<'_, Arc<App>>) -> Reply<()> {
    let s = app.settings.lock().await.clone();
    cloudflare::reconcile(&s).await.map_err(error)?;
    app.controller.start(s).await.map_err(error)
}
#[tauri::command]
async fn stop_connection(app: State<'_, Arc<App>>) -> Reply<()> {
    app.controller.stop().await.map_err(error)
}
#[tauri::command]
async fn open_workspace(app: State<'_, Arc<App>>) -> Reply<()> {
    let s = app.settings.lock().await;
    let path = PathBuf::from(&s.workspace);
    s.validate(&app.controller.install, false).map_err(error)?;
    tokio::fs::create_dir_all(&path).await.map_err(error)?;
    #[cfg(windows)]
    {
        let explorer =
            PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
                .join("explorer.exe");
        runtime::command(&explorer)
            .kill_on_drop(false)
            .arg(path)
            .spawn()
            .map_err(error)?;
    }
    Ok(())
}
#[tauri::command]
fn open_claude() -> Reply<()> {
    runtime::open_url("https://claude.ai/settings/connectors", &["claude.ai"]).map_err(error)
}
#[tauri::command]
async fn cloudflare_status() -> Reply<Value> {
    cloudflare::status().await.map_err(error)
}
#[tauri::command]
async fn cloudflare_login(app: State<'_, Arc<App>>) -> Reply<Value> {
    cloudflare::login(&app.controller.install)
        .await
        .map_err(error)
}
#[tauri::command]
async fn cloudflare_create(zone: String, prefix: String, app: State<'_, Arc<App>>) -> Reply<Value> {
    if app.controller.view()["running"] == true {
        return Err("Stop the connection before changing its address".into());
    }
    let mut s = app.settings.lock().await;
    cloudflare::create(&zone, &prefix, &mut s)
        .await
        .map_err(error)
}
async fn check(app: &App, current: &str) -> Reply<Value> {
    let result = updates::check(current).await.map_err(error)?;
    let value = result.as_ref().map(|u| json!({"version":u.version}));
    *app.update.lock().await = result;
    Ok(json!({"available":value.is_some(),"update":value}))
}
#[tauri::command]
async fn check_update(app: State<'_, Arc<App>>, handle: tauri::AppHandle) -> Reply<Value> {
    check(&app, &handle.package_info().version.to_string()).await
}
#[tauri::command]
async fn install_update(app: State<'_, Arc<App>>, handle: tauri::AppHandle) -> Reply<()> {
    let manifest = app
        .update
        .lock()
        .await
        .clone()
        .ok_or("Check for an update first")?;
    let installer = updates::download(&manifest).await.map_err(error)?;
    app.controller.stop().await.map_err(error)?;
    updates::launch(&installer, &app.controller.install).map_err(error)?;
    app.quitting.store(true, Ordering::SeqCst);
    handle.exit(0);
    Ok(())
}
fn show(handle: &tauri::AppHandle) {
    if let Some(window) = handle.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
fn main() {
    if std::env::args().any(|s| s == "--health-check") {
        std::process::exit(if secure::private_root().is_ok() { 0 } else { 1 });
    }
    if let Err(e) = run() {
        eprintln!("Codex Local MCP: {e}");
        std::process::exit(1);
    }
}
fn run() -> anyhow::Result<()> {
    secure::private_root()?;
    let install = std::env::current_exe()?.parent().unwrap().to_path_buf();
    codex_mcp_platform::migration::cleanup(&install)?;
    let settings = Settings::load()?;
    let app = Arc::new(App {
        controller: Controller::new(install),
        settings: tokio::sync::Mutex::new(settings),
        update: tokio::sync::Mutex::new(None),
        login: AtomicBool::new(false),
        quitting: AtomicBool::new(false),
    });
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|handle, _, _| {
            show(handle)
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(app)
        .invoke_handler(tauri::generate_handler![
            state,
            save_settings,
            generate_password,
            copy_password,
            account_status,
            account_login,
            sandbox_check,
            start_connection,
            stop_connection,
            open_workspace,
            open_claude,
            cloudflare_status,
            cloudflare_login,
            cloudflare_create,
            check_update,
            install_update
        ])
        .setup(|application| {
            let handle = application.handle();
            let open =
                MenuItem::with_id(handle, "open", "Open Codex Local MCP", true, None::<&str>)?;
            let update =
                MenuItem::with_id(handle, "update", "Check for updates", true, None::<&str>)?;
            let quit = MenuItem::with_id(handle, "quit", "Exit", true, None::<&str>)?;
            let menu = Menu::with_items(handle, &[&open, &update, &quit])?;
            TrayIconBuilder::new()
                .icon(application.default_window_icon().unwrap().clone())
                .tooltip("Codex Local MCP")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|handle, event| match event.id.as_ref() {
                    "open" => show(handle),
                    "update" => {
                        show(handle);
                        let handle = handle.clone();
                        tauri::async_runtime::spawn(async move {
                            let app = handle.state::<Arc<App>>();
                            match check(&app, &handle.package_info().version.to_string()).await {
                                Ok(value) => {
                                    use tauri::Emitter;
                                    let _ = handle.emit("update-check", value);
                                }
                                Err(e) => {
                                    use tauri::Emitter;
                                    let _ = handle.emit("update-error", e);
                                }
                            }
                        });
                    }
                    "quit" => {
                        let handle = handle.clone();
                        tauri::async_runtime::spawn(async move {
                            let app = handle.state::<Arc<App>>();
                            if app.controller.stop().await.is_ok() {
                                app.quitting.store(true, Ordering::SeqCst);
                                handle.exit(0);
                            }
                        });
                    }
                    _ => (),
                })
                .build(application)?;
            let handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(15)).await;
                loop {
                    let app = handle.state::<Arc<App>>();
                    if let Ok(value) = check(&app, &handle.package_info().version.to_string()).await
                        && value["available"] == true
                    {
                        let _ = handle
                            .notification()
                            .builder()
                            .title("Codex Local MCP update available")
                            .body(format!(
                                "Version {} is ready. Open the app to update.",
                                value["update"]["version"].as_str().unwrap_or("")
                            ))
                            .show();
                    }
                    tokio::time::sleep(Duration::from_secs(43200)).await;
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && !window.state::<Arc<App>>().quitting.load(Ordering::SeqCst)
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())?
        .run(|_, _| {});
    Ok(())
}
