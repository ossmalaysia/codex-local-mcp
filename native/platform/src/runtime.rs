use crate::{secure, settings::Settings};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::mpsc,
};

pub fn command(exe: &Path) -> Command {
    let mut cmd = Command::new(exe);
    cmd.kill_on_drop(true)
        .current_dir(exe.parent().unwrap())
        .env_clear();
    for key in [
        "SystemRoot",
        "WINDIR",
        "ComSpec",
        "SystemDrive",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "HOME",
        "APPDATA",
        "LOCALAPPDATA",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramData",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NO_PROXY",
        "SSL_CERT_FILE",
    ] {
        if let Some(v) = std::env::var_os(key) {
            cmd.env(key, v);
        }
    }
    let system =
        PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
            .join("System32");
    cmd.env(
        "PATH",
        std::env::join_paths([
            exe.parent().unwrap().to_path_buf(),
            exe.parent().unwrap().join("path"),
            system,
        ])
        .unwrap(),
    );
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    cmd
}
pub fn configure(cmd: &mut Command, install: &Path, settings: &Settings) -> Result<()> {
    let home = secure::root()?.join("codex-home");
    secure::no_links(&home)?;
    std::fs::create_dir_all(&home)?;
    cmd.env("CODEX_BIN", install.join("runtime/codex/codex.exe"))
        .env("CODEX_HOME", secure::root()?.join("codex-home"))
        .env("CODEX_MCP_ROOT", &settings.workspace)
        .env("CODEX_SANDBOX_MODE", "isolated")
        .env("CODEX_WINDOWS_SANDBOX", &settings.backend)
        .env("CODEX_NETWORK_ACCESS", settings.network.to_string())
        .env("CODEX_RUNTIME_ROOT", install)
        .env("CODEX_PRIVATE_ROOT", secure::root()?)
        .env("CODEX_MCP_TRANSPORT", "http")
        .env("CODEX_MCP_ACTIVITY", "1")
        .env("CODEX_MCP_HOST", "127.0.0.1")
        .env("CODEX_MCP_PORT", settings.port.to_string())
        .env("CODEX_MCP_USERNAME", &settings.username)
        .env("CODEX_MCP_TUNNEL", &settings.tunnel)
        .env(
            "CODEX_MCP_PUBLIC_URL",
            if settings.tunnel == "named" {
                settings.public_url.clone()
            } else {
                format!("http://127.0.0.1:{}", settings.port)
            },
        )
        .env("CLOUDFLARED_BIN", install.join("runtime/cloudflared.exe"));
    Ok(())
}
#[derive(Clone)]
pub struct Controller {
    pub install: PathBuf,
    running: Arc<AtomicBool>,
    stop: Arc<Mutex<Option<mpsc::Sender<()>>>>,
    state: Arc<Mutex<Value>>,
    pub tasks: Arc<Mutex<VecDeque<Value>>>,
    start_lock: Arc<tokio::sync::Mutex<()>>,
}
impl Controller {
    pub fn new(install: PathBuf) -> Self {
        Self {
            install,
            running: Arc::new(AtomicBool::new(false)),
            stop: Arc::new(Mutex::new(None)),
            state: Arc::new(Mutex::new(
                json!({"connected":false,"status":"Stopped","endpoint":"","lastRequest":null}),
            )),
            tasks: Arc::new(Mutex::new(VecDeque::new())),
            start_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }
    pub fn view(&self) -> Value {
        let mut value = self.state.lock().unwrap().clone();
        value["running"] = json!(self.running.load(Ordering::SeqCst));
        value["tasks"] = json!(self.tasks.lock().unwrap().clone());
        value
    }
    pub async fn start(&self, settings: Settings) -> Result<()> {
        let _guard = self.start_lock.lock().await;
        ensure!(
            !self.running.load(Ordering::SeqCst),
            "The connection is already running"
        );
        settings.validate(&self.install, true)?;
        tokio::fs::create_dir_all(&settings.workspace).await?;
        let exe = self.install.join("runtime/codex-mcp-service.exe");
        ensure!(
            exe.is_file(),
            "The native MCP service is missing. Install the complete update"
        );
        let mut cmd = command(&exe);
        configure(&mut cmd, &self.install, &settings)?;
        let mut child = cmd
            .args(["--tunnel", "--managed", "--secrets-stdin"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let mut input = child.stdin.take().unwrap();
        let password = secure::unprotect(&settings.password)?;
        let token = secure::unprotect(&settings.tunnel_token)?;
        let mut secrets = zeroize::Zeroizing::new(serde_json::to_vec(
            &json!({"password":std::str::from_utf8(&password)?,"tunnelToken":std::str::from_utf8(&token)?}),
        )?);
        secrets.push(b'\n');
        input.write_all(&secrets).await?;
        input.flush().await?;
        self.running.store(true, Ordering::SeqCst);
        *self.state.lock().unwrap() = json!({"connected":false,"status":"Checking sandbox and opening tunnel…","endpoint":if settings.tunnel=="named" {format!("{}/mcp",settings.public_url)} else {String::new()},"lastRequest":null});
        let stderr = child.stderr.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let controller = self.clone();
        let settings_root = PathBuf::from(&settings.workspace);
        let reader = tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = Vec::new();
            loop {
                line.clear();
                let count = bounded_line(&mut reader, &mut line, 16384)
                    .await
                    .unwrap_or(0);
                if count == 0 {
                    break;
                }
                if line.len() > 16384 {
                    continue;
                }
                let line = String::from_utf8_lossy(&line);
                controller.message(line.trim(), &settings_root);
            }
        });
        let drain = tokio::spawn(async move {
            let mut output = stdout;
            let mut buf = [0; 4096];
            while output.read(&mut buf).await.is_ok_and(|n| n > 0) {}
        });
        let (tx, mut rx) = mpsc::channel(1);
        *self.stop.lock().unwrap() = Some(tx);
        let controller = self.clone();
        tokio::spawn(async move {
            tokio::select! { _=child.wait()=>(), _=rx.recv()=>{ let _=input.write_all(b"stop\n").await; let _=input.flush().await; if tokio::time::timeout(Duration::from_secs(8),child.wait()).await.is_err(){let _=child.kill().await;} } }
            reader.abort();
            drain.abort();
            controller.running.store(false, Ordering::SeqCst);
            let mut state = controller.state.lock().unwrap();
            state["connected"] = json!(false);
            if state["status"]
                .as_str()
                .is_none_or(|s| !s.starts_with("Error:"))
            {
                state["status"] = json!("Stopped");
            }
            for task in controller
                .tasks
                .lock()
                .unwrap()
                .iter_mut()
                .filter(|v| v["status"] == "running")
            {
                task["status"] = json!("interrupted");
            }
        });
        Ok(())
    }
    fn message(&self, line: &str, root: &Path) {
        if let Some(event) = line
            .strip_prefix("codex-local-mcp activity: ")
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
        {
            if event["v"] != 1 {
                return;
            }
            let action = event["action"].as_str().unwrap_or("");
            if ![
                "initialize",
                "tools/list",
                "resources/list",
                "resources/read",
                "codex_run",
                "codex_generate_image",
                "codex_job_result",
                "codex_read_artifact",
            ]
            .contains(&action)
            {
                return;
            }
            if event["type"] == "request" {
                self.state.lock().unwrap()["lastRequest"] = json!({"action":action,"at":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()});
                return;
            }
            let Some(id) = event["id"].as_str().filter(|s| {
                s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            }) else {
                return;
            };
            let Some(workspace) = event["workspace"].as_str() else {
                return;
            };
            let path = PathBuf::from(workspace);
            if !within(&path, root) {
                return;
            }
            let mut tasks = self.tasks.lock().unwrap();
            if let Some(existing) = tasks.iter_mut().find(|v| v["id"] == id) {
                for (key, value) in event.as_object().unwrap() {
                    existing[key] = value.clone();
                }
            } else {
                if tasks.len() >= 100 {
                    if let Some(i) = tasks.iter().position(|v| v["status"] != "running") {
                        tasks.remove(i);
                    } else {
                        return;
                    }
                }
                tasks.push_front(event);
            }
        } else if let Some(rest) = line.strip_prefix("codex-local-mcp ready: ") {
            if let Some(url) = rest
                .split_whitespace()
                .next()
                .and_then(|s| url::Url::parse(s).ok())
                .filter(|u| {
                    u.scheme() == "https"
                        && u.path() == "/mcp"
                        && u.username().is_empty()
                        && u.query().is_none()
                        && u.fragment().is_none()
                })
            {
                let mut state = self.state.lock().unwrap();
                state["connected"] = json!(true);
                state["status"] = json!("Connected");
                state["endpoint"] = json!(url.as_str());
            }
        } else if line.starts_with("codex-local-mcp:")
            || line.starts_with("Cloudflare Tunnel stopped.")
        {
            self.state.lock().unwrap()["status"] = json!(format!(
                "Error: {}",
                line.chars().take(300).collect::<String>()
            ));
        }
    }
    pub async fn stop(&self) -> Result<()> {
        let sender = self.stop.lock().unwrap().take();
        if let Some(sender) = sender {
            let _ = sender.send(()).await;
        }
        for _ in 0..100 {
            if !self.running.load(Ordering::SeqCst) {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        anyhow::bail!("The connection is still stopping")
    }
    pub async fn probe(&self, settings: Settings) -> Result<Value> {
        settings.validate(&self.install, false)?;
        tokio::fs::create_dir_all(&settings.workspace).await?;
        let mut cmd = command(&self.install.join("runtime/codex-mcp-service.exe"));
        configure(&mut cmd, &self.install, &settings)?;
        let mut child = cmd
            .arg("--sandbox-probe")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let stdout = child.stdout.take().unwrap();
        let capture = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stdout
                .take(16385)
                .read_to_end(&mut bytes)
                .await
                .map(|_| bytes)
        });
        let status = tokio::time::timeout(Duration::from_secs(40), child.wait()).await??;
        let bytes = tokio::time::timeout(Duration::from_secs(3), capture).await???;
        ensure!(
            bytes.len() <= 16384,
            "The sandbox response exceeds its size limit"
        );
        ensure!(
            status.success(),
            "The sandbox check failed. Check the Windows backend"
        );
        let text = String::from_utf8_lossy(&bytes);
        let result = text
            .lines()
            .find_map(|line| serde_json::from_str::<Value>(line).ok())
            .ok_or_else(|| anyhow::anyhow!("Sandbox result is missing"))?;
        ensure!(result["passed"] == true, "The sandbox check failed");
        Ok(result)
    }
}

pub fn open_url(raw: &str, hosts: &[&str]) -> Result<()> {
    let url = url::Url::parse(raw)?;
    ensure!(
        url.scheme() == "https"
            && hosts.contains(&url.host_str().unwrap_or(""))
            && url.username().is_empty()
            && url.password().is_none(),
        "Refusing an untrusted browser address"
    );
    #[cfg(windows)]
    {
        let system =
            PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
                .join("explorer.exe");
        command(&system).arg(url.as_str()).spawn()?;
    }
    Ok(())
}

pub async fn account(install: &Path, login: bool) -> Result<Value> {
    let home = secure::root()?.join("codex-home");
    secure::no_links(&home)?;
    tokio::fs::create_dir_all(&home).await?;
    let exe = install.join("runtime/codex/codex.exe");
    let mut cmd = command(&exe);
    cmd.env("CODEX_HOME", secure::root()?.join("codex-home"));
    let mut child = cmd
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut total = 0usize;
    input.write_all(b"{\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"codex_local_mcp\",\"version\":\"1\"}}}\n").await?;
    let work = async {
        loop {
            let mut bytes = Vec::new();
            let count = bounded_line(&mut output, &mut bytes, 1048576).await?;
            total += count;
            ensure!(
                count > 0 && total <= 1048576,
                "Account response is unavailable"
            );
            let message: Value = serde_json::from_slice(&bytes)?;
            if message["id"] == 1 {
                ensure!(
                    message.get("error").is_none(),
                    "Codex account initialization failed"
                );
                input
                    .write_all(b"{\"method\":\"initialized\",\"params\":{}}\n")
                    .await?;
                input.write_all(if login {b"{\"id\":2,\"method\":\"account/login/start\",\"params\":{\"type\":\"chatgpt\"}}\n"} else {b"{\"id\":2,\"method\":\"account/read\",\"params\":{\"refreshToken\":false}}\n"}).await?;
            } else if message["id"] == 2 {
                ensure!(
                    message.get("error").is_none(),
                    "Codex account request failed"
                );
                if login {
                    let url = message["result"]["authUrl"].as_str().ok_or_else(|| {
                        anyhow::anyhow!("OpenAI did not return a sign-in address")
                    })?;
                    open_url(url, &["auth.openai.com", "chatgpt.com", "auth0.openai.com"])?;
                } else {
                    let account = &message["result"]["account"];
                    let email = account["email"]
                        .as_str()
                        .filter(|s| s.len() <= 320 && !s.chars().any(char::is_control));
                    return Ok(
                        json!({"signedIn":!account.is_null(),"email":email,"method":account["type"]}),
                    );
                }
            } else if login && message["method"] == "account/login/completed" {
                ensure!(
                    message["params"]["success"] == true,
                    "OpenAI sign-in did not finish"
                );
                return Ok(json!({"signedIn":true}));
            }
        }
    };
    let result =
        tokio::time::timeout(Duration::from_secs(if login { 480 } else { 12 }), work).await?;
    let _ = child.kill().await;
    result
}

pub async fn bounded_line<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    bytes: &mut Vec<u8>,
    limit: usize,
) -> std::io::Result<usize> {
    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() {
            return Ok(bytes.len());
        }
        let n = buffer
            .iter()
            .position(|b| *b == b'\n')
            .map_or(buffer.len(), |n| n + 1);
        if bytes.len() + n > limit {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Child response exceeds its size limit",
            ));
        }
        bytes.extend_from_slice(&buffer[..n]);
        let done = buffer[n - 1] == b'\n';
        reader.consume(n);
        if done {
            return Ok(bytes.len());
        }
    }
}
fn within(path: &Path, root: &Path) -> bool {
    let p = path
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('/', "\\")
        .to_lowercase();
    let r = root
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('/', "\\")
        .to_lowercase();
    p == r || p.starts_with(&(r.trim_end_matches('\\').to_owned() + "\\"))
}
#[cfg(test)]
mod tests {
    use super::{bounded_line, within};
    use std::path::Path;
    #[tokio::test]
    async fn child_lines_have_a_hard_memory_bound() {
        let mut reader = tokio::io::BufReader::new(&b"abcdef\n"[..]);
        let mut bytes = Vec::new();
        assert!(bounded_line(&mut reader, &mut bytes, 3).await.is_err());
        assert!(bytes.len() <= 3);
    }
    #[test]
    fn task_paths_require_a_directory_boundary() {
        assert!(within(Path::new(r"C:\work\task"), Path::new(r"C:\work")));
        assert!(!within(
            Path::new(r"C:\workspace\task"),
            Path::new(r"C:\work")
        ));
    }
}
