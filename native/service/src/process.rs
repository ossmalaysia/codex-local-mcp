use crate::{activity::Marker, config::Config};
use anyhow::{Result, ensure};
use std::{
    path::Path,
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
};
use tokio_util::sync::CancellationToken;

pub struct Output {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
    pub timed_out: bool,
    pub duration: u128,
}

pub fn command(bin: &Path) -> Command {
    let mut cmd = Command::new(bin);
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW.
    #[cfg(unix)]
    cmd.process_group(0);
    // Do not pass service secrets or application control settings to children.
    cmd.env_clear();
    for (key, value) in std::env::vars_os() {
        let key_s = key.to_string_lossy().to_ascii_uppercase();
        if [
            "SYSTEMROOT",
            "WINDIR",
            "COMSPEC",
            "SYSTEMDRIVE",
            "TEMP",
            "TMP",
            "TMPDIR",
            "HOME",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "PROGRAMDATA",
            "PROGRAMFILES",
            "PROGRAMFILES(X86)",
            "CODEX_HOME",
            "OPENAI_API_KEY",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "NODE_OPTIONS",
            "XDG_CONFIG_HOME",
        ]
        .contains(&key_s.as_str())
        {
            cmd.env(key, value);
        }
    }
    let mut paths = vec![bin.parent().unwrap().to_path_buf()];
    paths.extend(
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .filter(|p| p.is_absolute()),
    );
    if let Ok(path) = std::env::join_paths(paths) {
        cmd.env("PATH", path);
    }
    cmd
}

pub async fn login(config: &Config) -> Result<()> {
    let mut child = command(&config.bin)
        .args(["login", "status"])
        .current_dir(config.bin.parent().unwrap())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let _job = Tree::attach(&child)?;
    let status = tokio::time::timeout(Duration::from_secs(10), child.wait()).await;
    ensure!(
        status.is_ok_and(|r| r.is_ok_and(|s| s.success())),
        "Codex login is unavailable. Sign in to Codex in the app"
    );
    Ok(())
}

pub async fn run(
    config: &Config,
    workspace: &Path,
    prompt: String,
    timeout: u64,
    model: &str,
    cancel: CancellationToken,
    report: Arc<dyn Fn(&'static str) + Send + Sync>,
) -> Result<Output> {
    ensure!(
        model.len() <= 128
            && model
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:/-".contains(&b)),
        "Invalid model name"
    );
    let started = Instant::now();
    let mut cmd = command(&config.bin);
    cmd.arg("exec")
        .arg("--cd")
        .arg(workspace)
        .args(config.sandbox_args())
        .arg("--skip-git-repo-check");
    if !model.is_empty() {
        cmd.args(["--model", model]);
    }
    cmd.arg("-")
        .current_dir(config.bin.parent().unwrap())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let tree = Tree::attach(&child)?;
    let stdout = tokio::spawn(capture(child.stdout.take().unwrap(), config.output, None));
    let stderr = tokio::spawn(capture(
        child.stderr.take().unwrap(),
        config.output,
        Some(report),
    ));
    let mut stdin = child.stdin.take().unwrap();
    let writer = tokio::spawn(async move {
        let _ = stdin.write_all(prompt.as_bytes()).await;
        let _ = stdin.shutdown().await;
    });
    let timed_out;
    let code;
    tokio::select! {
        result = child.wait() => { code = result?.code(); timed_out = false; }
        _ = tokio::time::sleep(Duration::from_secs(timeout)) => { code = None; timed_out = true; }
        _ = cancel.cancelled() => { code = None; timed_out = false; }
    }
    // Terminate descendants even when the parent exits but descendants retain its pipes.
    drop(tree);
    let _ = child.kill().await;
    writer.abort();
    let collect = async { Ok::<_, anyhow::Error>((stdout.await??, stderr.await??)) };
    let (stdout, stderr) = tokio::time::timeout(Duration::from_secs(5), collect).await??;
    Ok(Output {
        stdout,
        stderr,
        code,
        timed_out,
        duration: started.elapsed().as_millis(),
    })
}

async fn capture(
    mut stream: impl AsyncRead + Unpin,
    max: usize,
    report: Option<Arc<dyn Fn(&'static str) + Send + Sync>>,
) -> Result<String> {
    let mut head = Vec::new();
    let mut tail = std::collections::VecDeque::new();
    let mut dropped = 0usize;
    let mut chunk = [0u8; 8192];
    let mut marker = Marker::default();
    loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        if let Some(ref callback) = report {
            marker.push(&chunk[..n], |phase| callback(phase));
        }
        for b in &chunk[..n] {
            if head.len() < max / 2 {
                head.push(*b);
            } else {
                tail.push_back(*b);
                if tail.len() > max - max / 2 {
                    tail.pop_front();
                    dropped += 1;
                }
            }
        }
    }
    let separator = if dropped > 0 {
        format!("\n\n...[{dropped} bytes omitted]...\n\n")
    } else {
        String::new()
    };
    Ok(format!(
        "{}{separator}{}",
        String::from_utf8_lossy(&head),
        String::from_utf8_lossy(tail.make_contiguous())
    ))
}

// The handle owns the entire child tree. Closing it kills remaining descendants.
#[cfg(windows)]
pub struct Tree(windows::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for Tree {}
#[cfg(windows)]
impl Tree {
    pub fn attach(child: &tokio::process::Child) -> Result<Self> {
        use windows::Win32::{
            Foundation::{CloseHandle, HANDLE},
            System::{
                JobObjects::*,
                Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE},
            },
        };
        // SAFETY: All handles are checked, borrowed only for calls, and closed exactly once.
        unsafe {
            let job = CreateJobObjectW(None, None)?;
            let guard = Self(job);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            )?;
            let process = OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE,
                false,
                child
                    .id()
                    .ok_or_else(|| anyhow::anyhow!("Child has no process ID"))?,
            )?;
            let result = AssignProcessToJobObject(job, HANDLE(process.0));
            let _ = CloseHandle(process);
            result?;
            Ok(guard)
        }
    }
}
#[cfg(windows)]
impl Drop for Tree {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(unix)]
pub struct Tree(u32);
#[cfg(unix)]
impl Tree {
    pub fn attach(child: &tokio::process::Child) -> Result<Self> {
        Ok(Self(child.id().ok_or_else(|| {
            anyhow::anyhow!("Child has no process ID")
        })?))
    }
}
#[cfg(unix)]
impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::process::Command::new("/bin/kill")
            .args(["-KILL", "--", &format!("-{}", self.0)])
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn bounded_capture_keeps_head_and_tail() {
        let result = capture(&b"abcdefghijklmno"[..], 6, None).await.unwrap();
        assert!(result.starts_with("abc"));
        assert!(result.ends_with("mno"));
        assert!(result.contains("9 bytes omitted"));
    }
}
