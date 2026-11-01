mod activity;
mod artifacts;
mod auth;
mod config;
mod generated;
mod http;
mod jobs;
mod probe;
mod process;
mod protocol;
#[path = "../../task_options.rs"]
mod task_options;
mod tunnel;
mod workspace;

use anyhow::{Result, ensure};
use config::{Config, value};
use rmcp::ServiceExt;
use std::sync::Arc;
use zeroize::Zeroizing;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedSecrets {
    password: String,
    tunnel_token: String,
}
impl Drop for ManagedSecrets {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.password.zeroize();
        self.tunnel_token.zeroize();
    }
}

async fn secrets(args: &[String]) -> Result<ManagedSecrets> {
    if !args.iter().any(|a| a == "--secrets-stdin") {
        return Ok(ManagedSecrets {
            password: value("CODEX_MCP_PASSWORD", ""),
            tunnel_token: value("CODEX_MCP_TUNNEL_TOKEN", ""),
        });
    }
    ensure!(
        args.iter().any(|a| a == "--managed"),
        "Secret input requires managed mode"
    );
    use tokio::io::AsyncReadExt;
    let mut input = tokio::io::stdin();
    let mut data = Zeroizing::new(Vec::new());
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let b = input.read_u8().await?;
            if b == b'\n' {
                break;
            }
            ensure!(
                data.len() < 16384,
                "Managed configuration exceeds its byte limit"
            );
            data.push(b);
        }
        serde_json::from_slice(&data).map_err(|_| anyhow::anyhow!("Invalid managed configuration"))
    })
    .await?
}

fn main() {
    // Bound thread creation on high-core Windows hosts. Workloads are mostly child I/O.
    let result = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(8)
        .enable_all()
        .build()
        .map_err(anyhow::Error::from)
        .and_then(|runtime| runtime.block_on(start()));
    if let Err(error) = result {
        eprintln!("codex-local-mcp: {error}");
        std::process::exit(1);
    }
}

async fn start() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|a| a == "--sandbox-check-child") {
        return probe::child(&args[1..]);
    }
    if args.iter().any(|a| a == "--version") {
        println!(
            "codex-mcp-service {}",
            option_env!("CODEX_MCP_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
        );
        return Ok(());
    }
    if args.as_slice() == ["--sandbox-probe"] {
        return probe::check(&Config::load()?).await;
    }
    ensure!(
        args.iter()
            .all(|a| ["--http", "--managed", "--tunnel", "--secrets-stdin"].contains(&a.as_str())),
        "Supported options: --http --managed --tunnel --secrets-stdin --sandbox-probe --version"
    );
    let secrets = secrets(&args).await?;
    let config = Arc::new(Config::load()?);
    let jobs = jobs::Jobs::new(config.clone());
    if args.iter().any(|a| a == "--http" || a == "--tunnel")
        || value("CODEX_MCP_TRANSPORT", "stdio") == "http"
    {
        let host = value("CODEX_MCP_HOST", "127.0.0.1");
        ensure!(
            ["127.0.0.1", "::1"].contains(&host.as_str()),
            "The native HTTP service must bind to loopback"
        );
        let port: u16 = value("CODEX_MCP_PORT", "3000").parse()?;
        let mut public = url::Url::parse(&value(
            "CODEX_MCP_PUBLIC_URL",
            &format!("http://127.0.0.1:{port}"),
        ))?;
        // Saved in the private directory so an update or restart keeps Claude signed in.
        let sessions = (!config.private.is_empty())
            .then(|| std::path::PathBuf::from(&config.private).join("oauth-sessions.json"));
        let tunnel = args.iter().any(|a| a == "--tunnel");
        // Validate credentials and public origin before starting any tunnel. A tunnel
        // can change the origin, so only the final authority keeps sessions.
        let initial_auth = auth::Auth::with_sessions(
            public.clone(),
            value("CODEX_MCP_USERNAME", "admin"),
            secrets.password.clone(),
            if tunnel { None } else { sessions.clone() },
        )?;
        process::login(&config).await?;
        if config.mode == "isolated" {
            probe::check(&config).await?;
        }
        let listener = tokio::net::TcpListener::bind((host.as_str(), port)).await?;
        let cancel = jobs.cancel.clone();
        let managed = args.iter().any(|a| a == "--managed");
        tokio::spawn(async move {
            if managed {
                use tokio::io::AsyncBufReadExt;
                let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) if line.trim() != "stop" => continue,
                        _ => break,
                    }
                }
            } else {
                let _ = tokio::signal::ctrl_c().await;
            }
            cancel.cancel();
        });
        let auth = if tunnel {
            ensure!(host == "127.0.0.1", "Cloudflare requires IPv4 loopback");
            eprintln!("Activating Cloudflare Tunnel...");
            public =
                tunnel::start(port, public, &secrets.tunnel_token, jobs.cancel.clone()).await?;
            auth::Auth::with_sessions(
                public.clone(),
                value("CODEX_MCP_USERNAME", "admin"),
                secrets.password.clone(),
                sessions,
            )?
        } else {
            initial_auth
        };
        eprintln!(
            "codex-local-mcp ready: {} (OAuth login required)",
            public.join("mcp")?
        );
        axum::serve(listener, http::router(auth, jobs.clone()))
            .with_graceful_shutdown(jobs.cancel.clone().cancelled_owned())
            .await?;
    } else {
        let service = protocol::Protocol { jobs: jobs.clone() }
            .serve(rmcp::transport::stdio())
            .await?;
        service.waiting().await?;
        jobs.cancel.cancel();
    }
    Ok(())
}
