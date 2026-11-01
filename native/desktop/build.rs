fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "state",
            "save_settings",
            "generate_password",
            "copy_password",
            "account_status",
            "account_login",
            "sandbox_check",
            "start_connection",
            "stop_connection",
            "open_workspace",
            "open_claude",
            "cloudflare_status",
            "cloudflare_login",
            "cloudflare_create",
            "check_update",
            "install_update",
        ]),
    ))
    .expect("desktop build configuration");
}
