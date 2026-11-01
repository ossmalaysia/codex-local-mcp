use crate::secure;
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase", default)]
pub struct Settings {
    pub workspace: String,
    pub username: String,
    pub password: String,
    pub tunnel: String,
    pub tunnel_token: String,
    pub public_url: String,
    pub backend: String,
    pub network: bool,
    pub port: u16,
    pub execution: crate::task_options::TaskOptions,
    /// Off by default: prompts can hold private text, so showing them in
    /// desktop activity is an explicit choice.
    pub show_prompts: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            workspace: std::env::var("LOCALAPPDATA")
                .map(|s| format!("{s}/CodexMCPWorkspaces"))
                .unwrap_or_default(),
            username: "admin".into(),
            password: String::new(),
            tunnel: "quick".into(),
            tunnel_token: String::new(),
            public_url: String::new(),
            backend: "mxc".into(),
            network: false,
            port: 3000,
            execution: Default::default(),
            show_prompts: false,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    pub workspace: String,
    pub username: String,
    pub password: String,
    pub tunnel: String,
    pub tunnel_token: String,
    pub public_url: String,
    pub backend: String,
    pub network: bool,
    pub port: u16,
    #[serde(default)]
    pub execution: crate::task_options::TaskOptions,
    #[serde(default)]
    pub show_prompts: bool,
}
impl Settings {
    pub fn load() -> Result<Self> {
        let path = secure::root()?.join("settings.json");
        secure::no_links(&path)?;
        if !path.exists() {
            return Ok(Self::default());
        }
        ensure!(
            path.metadata()?.len() < 131072,
            "Settings exceed the size limit"
        );
        Ok(serde_json::from_slice(&std::fs::read(path)?)?)
    }
    pub fn save(&self) -> Result<()> {
        secure::atomic(
            &secure::root()?.join("settings.json"),
            &serde_json::to_vec(self)?,
        )
    }
    pub fn update(&mut self, input: Input, install: &Path) -> Result<()> {
        let mut next = self.clone();
        next.workspace = input.workspace;
        next.username = input.username.trim().into();
        next.tunnel = input.tunnel;
        next.public_url = input.public_url.trim().trim_end_matches('/').into();
        next.backend = input.backend;
        next.network = input.network;
        next.port = input.port;
        next.execution = input.execution;
        next.show_prompts = input.show_prompts;
        if !input.password.is_empty() {
            next.password = secure::protect(input.password.as_bytes())?;
        }
        if !input.tunnel_token.is_empty() {
            next.tunnel_token = secure::protect(input.tunnel_token.trim().as_bytes())?;
        }
        next.validate(install, false)?;
        next.save()?;
        *self = next;
        Ok(())
    }
    pub fn validate(&self, install: &Path, connection: bool) -> Result<()> {
        self.execution.validate()?;
        let workspace = PathBuf::from(&self.workspace);
        ensure!(
            !workspace.components().any(|c| matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )),
            "Workspace paths must not contain dot segments"
        );
        ensure!(
            workspace.is_absolute() && !self.workspace.starts_with(r"\\"),
            "Choose an absolute local workspace folder"
        );
        let private = secure::root()?;
        let workspace = std::path::absolute(workspace)?;
        ensure!(
            workspace.parent().is_some()
                && !overlap(&workspace, install)
                && !overlap(&workspace, &private),
            "Keep workspaces separate from the application and its private data"
        );
        secure::no_links(&workspace)?;
        ensure!(
            !self.username.is_empty() && self.username.len() <= 256,
            "Enter an MCP username"
        );
        ensure!(
            ["mxc", "elevated"].contains(&self.backend.as_str()),
            "Choose a supported Windows sandbox"
        );
        ensure!(
            ["quick", "named"].contains(&self.tunnel.as_str()),
            "Choose a connection type"
        );
        ensure!(
            self.port >= 1024,
            "Choose a listener port between 1024 and 65535"
        );
        if !self.password.is_empty() {
            let password = secure::unprotect(&self.password)?;
            ensure!(
                std::str::from_utf8(&password)?.chars().count() >= 24 && password.len() <= 1024,
                "Use an MCP password with at least 24 characters and at most 1024 UTF-8 bytes"
            );
        }
        if connection {
            ensure!(
                !self.password.is_empty(),
                "Generate or save an MCP password first"
            );
        }
        if self.tunnel == "named" && (!self.public_url.is_empty() || connection) {
            let url = url::Url::parse(&self.public_url)?;
            ensure!(
                url.scheme() == "https"
                    && url.path() == "/"
                    && url.query().is_none()
                    && url.fragment().is_none()
                    && url.username().is_empty()
                    && url.password().is_none(),
                "Use an HTTPS origin without a path"
            );
            if connection {
                ensure!(
                    !self.tunnel_token.is_empty(),
                    "Create a Cloudflare address or save its tunnel token"
                );
            }
        }
        Ok(())
    }
    pub fn view(&self) -> serde_json::Value {
        serde_json::json!({"workspace":self.workspace,"username":self.username,"passwordSaved":!self.password.is_empty(),"tunnel":self.tunnel,"tokenSaved":!self.tunnel_token.is_empty(),"publicUrl":self.public_url,"backend":self.backend,"network":self.network,"port":self.port,"execution":self.execution,"showPrompts":self.show_prompts})
    }
}
fn overlap(a: &Path, b: &Path) -> bool {
    let a = a.to_string_lossy().replace('/', "\\").to_lowercase();
    let b = b.to_string_lossy().replace('/', "\\").to_lowercase();
    a.trim_end_matches('\\') == b.trim_end_matches('\\')
        || a.starts_with(&(b.trim_end_matches('\\').to_owned() + "\\"))
        || b.starts_with(&(a.trim_end_matches('\\').to_owned() + "\\"))
}
