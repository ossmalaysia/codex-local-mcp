use anyhow::{Result, bail, ensure};
use std::{
    env,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone)]
pub struct Config {
    pub root: PathBuf,
    pub bin: PathBuf,
    pub model: String,
    pub mode: String,
    pub backend: String,
    pub network: bool,
    pub runtime: String,
    pub private: String,
    pub timeout: u64,
    pub max_timeout: u64,
    pub output: usize,
    pub wait: u64,
    pub max_jobs: usize,
    pub retention: Duration,
    pub inline: usize,
    pub response: usize,
    pub files: usize,
    pub activity: bool,
    /// The user's opt-in to show submitted prompts in desktop activity.
    pub activity_prompts: bool,
    pub defaults: crate::task_options::TaskOptions,
    /// codex_task projects. An invalid CODEX_PROJECTS is kept as its error, so
    /// it is reported by the tools that need it instead of stopping the service.
    pub projects: Result<crate::projects::Projects, String>,
    /// Absolute git executable, or why there is none; checked per codex_task.
    pub git: Result<PathBuf, String>,
    /// A patch up to this many characters is inlined; a larger one is linked.
    pub max_patch: usize,
}

/// Resolve an executable to an absolute path once, from absolute PATH entries
/// only: a relative entry would resolve against a directory Codex can write.
fn resolve_executable(raw: &str, missing: &str) -> Result<PathBuf> {
    if Path::new(raw).is_absolute() {
        return Ok(PathBuf::from(raw).canonicalize()?);
    }
    ensure!(
        !raw.contains(['/', '\\']),
        "Executable names must be absolute or bare"
    );
    Ok(env::split_paths(&env::var_os("PATH").unwrap_or_default())
        .filter(|p| p.is_absolute())
        .map(|p| p.join(raw))
        .find(|p| p.is_file())
        .ok_or_else(|| anyhow::anyhow!("{missing}"))?
        .canonicalize()?)
}

/// git is spawned directly, never through a shell, so on Windows only a native
/// .exe can run.
fn git_bin() -> Result<PathBuf, String> {
    let raw = value(
        "CODEX_GIT_BIN",
        if cfg!(windows) { "git.exe" } else { "git" },
    );
    let bin = resolve_executable(
        &raw,
        "Could not find git. Install git or set CODEX_GIT_BIN to its full path.",
    )
    .map_err(|e| format!("{e}"))?;
    if cfg!(windows)
        && bin
            .extension()
            .is_none_or(|e| !e.eq_ignore_ascii_case("exe"))
    {
        return Err("CODEX_GIT_BIN must be a native git.exe; shell launchers are refused".into());
    }
    Ok(bin)
}

pub fn value(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.into())
}
fn number(key: &str, default: u64, ceiling: u64) -> u64 {
    env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|v| *v > 0)
        .unwrap_or(default)
        .min(ceiling)
}

impl Config {
    pub fn load() -> Result<Self> {
        let home = value("USERPROFILE", &value("HOME", "."));
        let root = PathBuf::from(value(
            "CODEX_MCP_ROOT",
            &format!("{home}/.codex-mcp/workspaces"),
        ));
        std::fs::create_dir_all(&root)?;
        let root = root.canonicalize()?;
        let raw = value(
            "CODEX_BIN",
            if cfg!(windows) { "codex.exe" } else { "codex" },
        );
        let bin = resolve_executable(&raw, "Set CODEX_BIN to the native Codex executable")?;
        if cfg!(windows)
            && bin
                .extension()
                .is_none_or(|e| !e.eq_ignore_ascii_case("exe"))
        {
            bail!("The Rust service requires a native .exe; shell launchers are refused");
        }
        let mode = value("CODEX_SANDBOX_MODE", "workspace-write");
        ensure!(
            ["isolated", "workspace-write", "read-only"].contains(&mode.as_str()),
            "Invalid sandbox mode"
        );
        let backend = value("CODEX_WINDOWS_SANDBOX", "");
        ensure!(
            ["", "mxc", "elevated"].contains(&backend.as_str()),
            "Invalid Windows sandbox backend"
        );
        ensure!(
            value("CODEX_MCP_APP_VIEW", "false") != "true",
            "MCP App view is not yet supported by the native service; use the TypeScript service"
        );
        let defaults: crate::task_options::TaskOptions =
            serde_json::from_str(&value("CODEX_TASK_DEFAULTS", "{}"))?;
        defaults.validate()?;
        Ok(Self {
            defaults,
            root,
            bin,
            mode,
            backend,
            model: value("CODEX_MODEL", ""),
            network: value("CODEX_NETWORK_ACCESS", "true") != "false",
            runtime: value("CODEX_RUNTIME_ROOT", ""),
            private: value("CODEX_PRIVATE_ROOT", ""),
            timeout: number("CODEX_TIMEOUT_SEC", 300, 1800),
            max_timeout: number("CODEX_MAX_TIMEOUT_SEC", 1800, 86400),
            output: number("CODEX_MAX_OUTPUT_CHARS", 40_000, 1_000_000) as usize,
            wait: number("CODEX_WAIT_SEC", 45, 50),
            max_jobs: number("CODEX_MAX_RUNNING_JOBS", 4, 32) as usize,
            retention: Duration::from_secs(number("CODEX_JOB_RETENTION_SEC", 3600, 86400)),
            inline: number("CODEX_MAX_INLINE_IMAGE_B64", 350_000, 5_000_000) as usize,
            response: number("CODEX_MAX_RESPONSE_B64", 750_000, 10_000_000) as usize,
            files: number("CODEX_MAX_REPORTED_FILES", 200, 1000) as usize,
            activity: value("CODEX_MCP_ACTIVITY", "") == "1",
            activity_prompts: value("CODEX_MCP_ACTIVITY_PROMPTS", "") == "1",
            projects: crate::projects::parse(&value("CODEX_PROJECTS", "")),
            git: git_bin(),
            max_patch: number("CODEX_MAX_PATCH_CHARS", 200_000, 50_000_000) as usize,
        })
    }

    pub fn sandbox_args(&self) -> Vec<String> {
        self.sandbox_args_with(false, &[])
    }

    /// `read_only` keeps Codex from writing anything (codex_task review mode);
    /// `writable` adds folders it may write besides its workspace, such as a
    /// package cache.
    pub fn sandbox_args_with(&self, read_only: bool, writable: &[String]) -> Vec<String> {
        let toml_path = |p: &str| serde_json::to_string(&p.replace('\\', "/")).unwrap();
        let writable = if read_only { &[][..] } else { writable };
        let mut args = vec!["-c".into(), "approval_policy=never".into()];
        if self.mode == "isolated" {
            let workspace = if read_only { "read" } else { "write" };
            let mut fs = vec![
                "':minimal'='read'".into(),
                format!(
                    "':workspace_roots'={{'.'='{workspace}','.git'='read','.agents'='read','.codex'='read','.aws'='read'}}"
                ),
                "':tmpdir'='deny'".into(),
                "':slash_tmp'='deny'".into(),
            ];
            if !self.runtime.is_empty() {
                fs.push(format!("{}='read'", toml_path(&self.runtime)));
            }
            for root in writable {
                fs.push(format!("{}='write'", toml_path(root)));
            }
            if !self.private.is_empty() {
                fs.push(format!("{}='deny'", toml_path(&self.private)));
            }
            for setting in ["default_permissions=codex_mcp_isolated".into(), format!("permissions.codex_mcp_isolated.filesystem={{{}}}", fs.join(",")), "shell_environment_policy.set={NODE_OPTIONS='--preserve-symlinks --preserve-symlinks-main'}".into(), format!("permissions.codex_mcp_isolated.network.enabled={}", self.network)] {
                args.extend(["-c".into(), setting]);
            }
        } else {
            args.extend([
                "--sandbox".into(),
                if read_only {
                    "read-only".into()
                } else {
                    self.mode.clone()
                },
                "-c".into(),
                format!("sandbox_workspace_write.network_access={}", self.network),
            ]);
            if !writable.is_empty() {
                let roots: Vec<_> = writable.iter().map(|r| toml_path(r)).collect();
                args.extend([
                    "-c".into(),
                    format!(
                        "sandbox_workspace_write.writable_roots=[{}]",
                        roots.join(",")
                    ),
                ]);
            }
        }
        if cfg!(windows) && !self.backend.is_empty() {
            args.extend([
                "-c".into(),
                format!("windows.sandbox={}", self.backend),
                "-c".into(),
                "features.prefer_mxc=false".into(),
            ]);
        }
        args
    }
}
