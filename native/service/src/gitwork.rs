//! Git operations for codex_task: fetch a ref into a throwaway worktree of the
//! user's own clone, turn what Codex changed into a patch, and clean up.
//!
//! These run OUTSIDE the Codex sandbox, with the user's git credentials, so
//! none of them may execute repository code:
//! - Hooks are disabled. A clone can set core.hooksPath to a tracked folder
//!   (husky does), and `worktree add` would then run a post-checkout hook from
//!   the fetched ref, which is caller-controlled. hooksPath points BELOW the git
//!   executable, a regular file, so no hook can ever exist there: an empty
//!   directory would have to live somewhere, and every directory a Codex run can
//!   write to (its workspace, the temp directory) is somewhere it could plant one.
//! - Diffs use --no-ext-diff and --no-textconv, so attributes in the worktree
//!   cannot select a diff driver.
//! - No shell. git is an absolute executable, spawned directly, with the root as
//!   its working directory and the clone given by -C.
use crate::{config::Config, process};
use anyhow::{Result, anyhow, bail};
use std::{
    collections::HashMap,
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};
use tokio::io::AsyncReadExt;

const GIT_TIMEOUT: Duration = Duration::from_secs(300);

pub struct GitOutput {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
    pub code: Option<i32>,
}

/// Git for Windows does not reliably accept `\\?\` verbatim paths, which
/// canonicalize produces. Drive paths are passed in their ordinary form.
pub fn plain(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path.to_owned(),
    }
}

fn arg_error(e: &str) -> anyhow::Error {
    anyhow!("{e}")
}

/// Run git. With `to_file`, stdout goes straight to that file, intact: a patch
/// must never be cut short in memory.
pub async fn git(
    config: &Config,
    cwd: &Path,
    args: &[OsString],
    to_file: Option<std::fs::File>,
) -> Result<GitOutput> {
    let bin = config.git.as_ref().map_err(|e| arg_error(e))?;
    let mut cmd = process::command(bin);
    // The user's own SSH and git settings are how fetch authenticates.
    for key in [
        "SSH_AUTH_SOCK",
        "GIT_SSH",
        "GIT_SSH_COMMAND",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_NOSYSTEM",
    ] {
        if let Some(value) = std::env::var_os(key) {
            cmd.env(key, value);
        }
    }
    // Never wait on an interactive credential prompt nobody can answer.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    let mut hooks = bin.clone().into_os_string();
    hooks.push(std::path::MAIN_SEPARATOR_STR);
    hooks.push("no-hooks");
    let mut hooks_path = OsString::from("core.hooksPath=");
    hooks_path.push(hooks);
    cmd.arg("-c")
        .arg(hooks_path)
        .args(["-c", "core.fsmonitor=false", "-C"])
        .arg(plain(cwd))
        .args(args)
        // Like Codex, never a task workspace.
        .current_dir(&config.root)
        .stdin(Stdio::null())
        .stderr(Stdio::piped());
    let capture = to_file.is_none();
    match to_file {
        Some(file) => cmd.stdout(Stdio::from(file)),
        None => cmd.stdout(Stdio::piped()),
    };
    let mut child = cmd
        .spawn()
        .map_err(|e| anyhow!("git failed to start: {e}"))?;
    let tree = process::Tree::attach(&child)?;
    let stdout = child.stdout.take();
    let mut stderr = child.stderr.take().unwrap();
    // Bounded reads, then drain the rest so git never blocks on a full pipe.
    let out = tokio::spawn(async move {
        let mut data = Vec::new();
        if let Some(mut stdout) = stdout {
            (&mut stdout)
                .take(10_000_000)
                .read_to_end(&mut data)
                .await?;
            tokio::io::copy(&mut stdout, &mut tokio::io::sink()).await?;
        }
        Ok::<_, std::io::Error>(data)
    });
    let err = tokio::spawn(async move {
        let mut data = Vec::new();
        (&mut stderr).take(20_000).read_to_end(&mut data).await?;
        tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await?;
        Ok::<_, std::io::Error>(data)
    });
    let status = tokio::time::timeout(GIT_TIMEOUT, child.wait()).await;
    drop(tree);
    let _ = child.kill().await;
    let status = match status {
        Ok(status) => status?,
        Err(_) => bail!(
            "git did not finish within {} seconds",
            GIT_TIMEOUT.as_secs()
        ),
    };
    let stdout = if capture { out.await?? } else { Vec::new() };
    let stderr = err.await.ok().and_then(Result::ok).unwrap_or_default();
    Ok(GitOutput {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).trim().to_owned(),
        success: status.success(),
        code: status.code(),
    })
}

fn args<const N: usize>(items: [&dyn AsRef<std::ffi::OsStr>; N]) -> Vec<OsString> {
    items.iter().map(|a| a.as_ref().to_owned()).collect()
}

async fn git_ok(
    config: &Config,
    cwd: &Path,
    list: &[OsString],
    what: &str,
    to_file: Option<std::fs::File>,
) -> Result<String> {
    let output = git(config, cwd, list, to_file).await?;
    if !output.success {
        bail!(
            "{what} failed: {}",
            if output.stderr.is_empty() {
                format!("git exited with {:?}", output.code)
            } else {
                output.stderr
            }
        );
    }
    Ok(output.stdout)
}

/// One git operation at a time per clone. FETCH_HEAD and the worktree list are
/// shared state in the clone, so two jobs fetching at once could each check out
/// the other's commit.
static LOCKS: LazyLock<Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(Default::default);
fn lock(clone: &Path) -> Arc<tokio::sync::Mutex<()>> {
    // Windows paths are case-insensitive; one clone must map to one lock.
    let key = if cfg!(windows) {
        PathBuf::from(clone.to_string_lossy().to_lowercase())
    } else {
        clone.to_owned()
    };
    LOCKS.lock().unwrap().entry(key).or_default().clone()
}

/// Fetch `reference` from origin into the user's clone and check it out,
/// detached, in a fresh worktree at `dir`. Returns the base commit.
pub async fn create_worktree(
    config: &Config,
    clone: &Path,
    reference: &str,
    dir: &Path,
) -> Result<String> {
    let lock = lock(clone);
    let _guard = lock.lock().await;
    let fetched = git(
        config,
        clone,
        &args([
            &"fetch",
            &"--no-tags",
            &"--no-recurse-submodules",
            &"origin",
            &reference,
        ]),
        None,
    )
    .await?;
    if !fetched.success {
        bail!(
            "Could not fetch \"{reference}\" from origin: {}",
            if fetched.stderr.is_empty() {
                format!("git exited with {:?}", fetched.code)
            } else {
                fetched.stderr
            }
        );
    }
    // Resolve FETCH_HEAD under the lock; the next fetch overwrites it.
    let base = git_ok(
        config,
        clone,
        &args([
            &"rev-parse",
            &"--verify",
            &"--end-of-options",
            &"FETCH_HEAD^{commit}",
        ]),
        "Resolving the fetched commit",
        None,
    )
    .await?
    .trim()
    .to_owned();
    git_ok(
        config,
        clone,
        &args([&"worktree", &"add", &"--detach", &"--", &plain(dir), &base]),
        "Creating the worktree",
        None,
    )
    .await?;
    Ok(base)
}

/// Everything Codex changed, including new untracked files, as a binary-safe
/// patch against the base commit, written to `patch_file`, which must not exist
/// yet. Returns the diffstat. Staging first is what brings untracked files in;
/// .gitignore still applies, so dependency folders stay out.
pub async fn collect_patch(
    config: &Config,
    dir: &Path,
    base: &str,
    patch_file: &Path,
) -> Result<String> {
    git_ok(
        config,
        dir,
        &args([&"add", &"-A"]),
        "Staging the changes",
        None,
    )
    .await?;
    let diff = [
        "diff",
        "--cached",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
    ];
    // create_new: a fresh file, never one planted in advance or a link elsewhere.
    let file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(patch_file)
        .await?
        .into_std()
        .await;
    let mut list: Vec<OsString> = diff.iter().map(OsString::from).collect();
    list.extend(args([&"--binary", &base, &"--"]));
    git_ok(config, dir, &list, "Creating the patch", Some(file)).await?;
    let mut list: Vec<OsString> = diff.iter().map(OsString::from).collect();
    list.extend(args([&"--stat=200", &base, &"--"]));
    git_ok(config, dir, &list, "Summarising the patch", None).await
}

/// Remove the worktree and its registration. Called on every path, including
/// failure and timeout. If git cannot remove it (a lingering process holding a
/// file on Windows), the folder is deleted directly and the registration pruned.
pub async fn remove_worktree(config: &Config, clone: &Path, dir: &Path) {
    let lock = lock(clone);
    let _guard = lock.lock().await;
    let removed = git(
        config,
        clone,
        &args([&"worktree", &"remove", &"--force", &"--", &plain(dir)]),
        None,
    )
    .await;
    if !removed.is_ok_and(|o| o.success) {
        let dir = dir.to_owned();
        let _ = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(dir)).await;
    }
    let _ = git(config, clone, &args([&"worktree", &"prune"]), None).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_drive_paths_become_plain() {
        assert_eq!(
            plain(Path::new(r"\\?\C:\Users\a b\x")),
            PathBuf::from(r"C:\Users\a b\x")
        );
        assert_eq!(
            plain(Path::new(r"\\?\UNC\server\share")),
            PathBuf::from(r"\\?\UNC\server\share")
        );
        assert_eq!(plain(Path::new("/tmp/x")), PathBuf::from("/tmp/x"));
    }
}
