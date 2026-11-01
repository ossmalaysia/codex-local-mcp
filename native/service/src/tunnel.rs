use crate::{config::value, process};
use anyhow::{Result, ensure};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, sync::mpsc};
use tokio_util::sync::CancellationToken;
use url::Url;

struct TempConfig(PathBuf);
impl Drop for TempConfig {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.0.join("config.yml"));
        let _ = std::fs::remove_dir(&self.0);
    }
}

pub async fn start(port: u16, public: Url, token: &str, cancel: CancellationToken) -> Result<Url> {
    let bin = PathBuf::from(value("CLOUDFLARED_BIN", ""));
    ensure!(
        bin.is_absolute() && bin.is_file(),
        "CLOUDFLARED_BIN must point to an absolute native executable"
    );
    ensure!(
        !cfg!(windows)
            || bin
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("exe")),
        "Cloudflare requires a native executable"
    );
    let named = value("CODEX_MCP_TUNNEL", "quick") == "named";
    if named {
        ensure!(
            !token.is_empty() && public.scheme() == "https",
            "Named tunnels require a token and HTTPS origin"
        );
    }
    let temp = std::env::temp_dir().join(format!("codex-mcp-tunnel-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&temp)?;
    let config = TempConfig(temp);
    std::fs::write(config.0.join("config.yml"), "{}\n")?;
    let mut cmd = process::command(&bin);
    cmd.env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_HOME")
        .env_remove("NODE_OPTIONS");
    cmd.current_dir(bin.parent().unwrap())
        .args(["tunnel", "--config"])
        .arg(config.0.join("config.yml"))
        .arg("--no-autoupdate");
    if named {
        cmd.arg("run").env("TUNNEL_TOKEN", token);
    } else {
        cmd.args(["--url", &format!("http://127.0.0.1:{port}")]);
    }
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let tree = process::Tree::attach(&child)?;
    let (send, mut receive) = mpsc::channel::<Vec<u8>>(16);
    let mut drains = vec![];
    let streams: Vec<Box<dyn tokio::io::AsyncRead + Send + Unpin>> = vec![
        Box::new(child.stdout.take().unwrap()),
        Box::new(child.stderr.take().unwrap()),
    ];
    for mut stream in streams {
        let send = send.clone();
        drains.push(tokio::spawn(async move {
            let mut buffer = [0u8; 4096];
            while let Ok(n) = stream.read(&mut buffer).await {
                if n == 0 {
                    break;
                }
                if send.send(buffer[..n].to_vec()).await.is_err() {
                    break;
                }
            }
        }));
    }
    drop(send);
    let mut buffer = String::new();
    let mut url = if named { Some(public) } else { None };
    let mut connected = false;
    let activation = async {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => anyhow::bail!("Tunnel activation cancelled"),
                result = child.wait() => { let _ = result; anyhow::bail!("Cloudflare stopped before activation"); },
                chunk = receive.recv() => {
                    let Some(chunk) = chunk else { anyhow::bail!("Cloudflare closed its output before activation"); };
                    buffer.push_str(&String::from_utf8_lossy(&chunk));
                    if buffer.len() > 16384 { buffer = buffer.chars().rev().take(8192).collect::<String>().chars().rev().collect(); }
                    if url.is_none() { url = quick_url(&buffer); }
                    connected |= buffer.contains("Registered tunnel connection");
                    if connected && let Some(url) = url.take() { return Ok(url); }
                }
            }
        }
    };
    let result = tokio::time::timeout(Duration::from_secs(45), activation).await;
    let public = match result {
        Ok(Ok(url)) => url,
        Ok(Err(e)) => return Err(e),
        Err(_) => anyhow::bail!("Cloudflare activation timed out"),
    };
    tokio::spawn(async move {
        let _config = config;
        let _tree = tree;
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = child.wait() => { eprintln!("Cloudflare Tunnel stopped. Remote access is unavailable."); cancel.cancel(); break; },
                _ = receive.recv() => (),
            }
        }
        let _ = child.kill().await;
        for drain in drains {
            drain.abort();
        }
    });
    Ok(public)
}

fn quick_url(log: &str) -> Option<Url> {
    for suffix in log.split("https://").skip(1) {
        let end = suffix
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '.'))
            .unwrap_or(suffix.len());
        let host = &suffix[..end];
        if suffix[end..]
            .chars()
            .next()
            .is_some_and(|c| !c.is_whitespace() && !['|', '"', '\''].contains(&c))
        {
            continue;
        }
        if let Some(label) = host.strip_suffix(".trycloudflare.com")
            && !label.is_empty()
            && label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            && !label.starts_with('-')
            && !label.ends_with('-')
        {
            return Url::parse(&format!("https://{host}")).ok();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_untrusted_connector_urls() {
        assert_eq!(
            quick_url("| https://one-two.trycloudflare.com |\n")
                .unwrap()
                .host_str(),
            Some("one-two.trycloudflare.com")
        );
        for log in [
            "https://evil.test",
            "https://a.trycloudflare.com.evil.test",
            "https://a.b.trycloudflare.com",
            "https://-a.trycloudflare.com",
        ] {
            assert!(quick_url(log).is_none());
        }
    }
}
