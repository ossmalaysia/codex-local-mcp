use crate::{config::Config, process};
use anyhow::{Result, ensure};
use serde_json::json;
use std::{path::PathBuf, process::Stdio, time::Duration};

pub fn child(args: &[String]) -> Result<()> {
    ensure!(args.len() == 5, "Invalid sandbox check arguments");
    let read_denied = std::fs::read(&args[0]).is_err();
    let outside_read_denied = std::fs::read(&args[4]).is_err();
    let write_denied = std::fs::write(&args[1], "sandbox escape").is_err();
    let inside = PathBuf::from("inside.txt");
    let workspace_works = std::fs::write(&inside, "sandbox workspace check").is_ok()
        && std::fs::read(&inside).is_ok_and(|s| s == b"sandbox workspace check");
    let address = format!("127.0.0.1:{}", args[2]).parse()?;
    let connected =
        std::net::TcpStream::connect_timeout(&address, Duration::from_millis(1500)).is_ok();
    let passed = read_denied
        && outside_read_denied
        && write_denied
        && workspace_works
        && (args[3] == "true" || !connected);
    println!(
        "{}",
        json!({"passed":passed,"readDenied":read_denied,"outsideReadDenied":outside_read_denied,"writeDenied":write_denied,"workspaceWorks":workspace_works,"networkDenied":!connected})
    );
    ensure!(passed, "Sandbox probe failed");
    Ok(())
}

struct ProbeFiles {
    workspace: PathBuf,
    secret: PathBuf,
    outside: PathBuf,
}
impl Drop for ProbeFiles {
    fn drop(&mut self) {
        for path in [
            self.secret.clone(),
            self.secret.with_extension("write"),
            self.outside.join("sentinel.txt"),
            self.workspace.join("inside.txt"),
        ] {
            let _ = std::fs::remove_file(path);
        }
        let _ = std::fs::remove_dir(&self.workspace);
        let _ = std::fs::remove_dir(&self.outside);
    }
}
pub async fn check(config: &Config) -> Result<()> {
    ensure!(
        config.mode == "isolated" && !config.private.is_empty(),
        "Sandbox probe requires isolated mode and a private directory"
    );
    let id = uuid::Uuid::new_v4();
    let workspace = config.root.join(format!(".isolation-check-{id}"));
    let secret = PathBuf::from(&config.private).join(format!("codex-mcp-probe-{id}.txt"));
    let home = crate::config::value("USERPROFILE", &crate::config::value("HOME", ""));
    ensure!(!home.is_empty(), "Sandbox probe needs a home directory");
    let outside = PathBuf::from(home).join(format!(".codex-mcp-isolation-check-{id}"));
    let files = ProbeFiles {
        workspace,
        secret,
        outside,
    };
    tokio::fs::create_dir(&files.workspace).await?;
    tokio::fs::create_dir(&files.outside).await?;
    tokio::fs::create_dir_all(&config.private).await?;
    tokio::fs::write(&files.secret, id.to_string()).await?;
    tokio::fs::write(files.outside.join("sentinel.txt"), id.to_string()).await?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let mut cmd = process::command(&config.bin);
    cmd.args(config.sandbox_args())
        .args([
            "sandbox",
            "--include-managed-config",
            "--permission-profile",
            "codex_mcp_isolated",
            "--cd",
        ])
        .arg(&files.workspace)
        .arg("--")
        .arg(std::env::current_exe()?)
        .arg("--sandbox-check-child")
        .arg(&files.secret)
        .arg(files.secret.with_extension("write"))
        .arg(listener.local_addr()?.port().to_string())
        .arg(config.network.to_string())
        .arg(files.outside.join("sentinel.txt"))
        .current_dir(config.bin.parent().unwrap())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn()?;
    let _tree = process::Tree::attach(&child)?;
    use tokio::io::AsyncReadExt;
    let output = child.stdout.take().unwrap();
    let capture = tokio::spawn(async move {
        let mut data = Vec::new();
        output.take(6001).read_to_end(&mut data).await.map(|_| data)
    });
    let status = tokio::time::timeout(Duration::from_secs(30), child.wait()).await??;
    let data = tokio::time::timeout(Duration::from_secs(3), capture).await???;
    let result = String::from_utf8_lossy(&data);
    println!("{result}");
    ensure!(
        status.success() && data.len() <= 6000 && result.contains("\"passed\":true"),
        "Sandbox verification failed. Remote startup is blocked"
    );
    Ok(())
}
