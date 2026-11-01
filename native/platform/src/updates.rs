use crate::{runtime, secure};
use anyhow::{Result, ensure};
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::AsyncWriteExt;

pub const REPOSITORY: &str = "https://github.com/ossmalaysia/codex-local-mcp";
const KEY: &str = include_str!("../update-public-key.txt");
const MAX_INSTALLER: u64 = 1024 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub product: String,
    pub version: String,
    pub architecture: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

pub fn verify(bytes: &[u8], signature: &str, current: &str, expected: &str) -> Result<Manifest> {
    verify_with_key(bytes, signature, current, expected, KEY.trim())
}
fn verify_with_key(
    bytes: &[u8],
    signature: &str,
    current: &str,
    expected: &str,
    public_key: &str,
) -> Result<Manifest> {
    ensure!(
        bytes.len() <= 32768 && signature.len() <= 8192,
        "Update metadata exceeds its size limit"
    );
    let key = PublicKey::from_base64(public_key)?;
    let signature = Signature::decode(signature)?;
    key.verify(bytes, &signature, false)?;
    let manifest: Manifest = serde_json::from_slice(bytes)?;
    let next = semver::Version::parse(&manifest.version)?;
    ensure!(
        next.pre.is_empty() && next.build.is_empty() && next > semver::Version::parse(current)?,
        "The update version is not newer"
    );
    ensure!(
        manifest.version == expected
            && manifest.product == "codex-local-mcp"
            && manifest.architecture == "x64",
        "Update metadata does not match this application"
    );
    let url = format!(
        "{REPOSITORY}/releases/download/v{}/CodexLocalMCP-{}-windows-x64-setup.exe",
        manifest.version, manifest.version
    );
    ensure!(
        manifest.url == url
            && manifest.size > 0
            && manifest.size <= MAX_INSTALLER
            && manifest.sha256.len() == 64
            && manifest.sha256.bytes().all(|b| b.is_ascii_hexdigit()),
        "Update package metadata is invalid"
    );
    Ok(manifest)
}
fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent("CodexLocalMCP-Updater")
        .https_only(true)
        .timeout(Duration::from_secs(600))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("Too many download redirects");
            }
            let url = attempt.url();
            if url.scheme() == "https"
                && [
                    "github.com",
                    "release-assets.githubusercontent.com",
                    "objects.githubusercontent.com",
                ]
                .contains(&url.host_str().unwrap_or(""))
                && url.username().is_empty()
                && url.password().is_none()
            {
                attempt.follow()
            } else {
                attempt.error("Untrusted download redirect")
            }
        }))
        .build()?)
}
async fn bytes(url: &str, limit: usize) -> Result<Vec<u8>> {
    let mut response = client()?.get(url).send().await?.error_for_status()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            bytes.len() + chunk.len() <= limit,
            "The update response exceeds its size limit"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
pub async fn check(current: &str) -> Result<Option<Manifest>> {
    // The API supplies discovery only. The pinned key authenticates the metadata.
    let response = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("CodexLocalMCP-Updater")
        .timeout(Duration::from_secs(20))
        .build()?
        .get("https://api.github.com/repos/ossmalaysia/codex-local-mcp/releases/latest")
        .send()
        .await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let mut response = response.error_for_status()?;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            body.len() + chunk.len() <= 1048576,
            "Release response is too large"
        );
        body.extend_from_slice(&chunk);
    }
    let release: serde_json::Value = serde_json::from_slice(&body)?;
    ensure!(
        release["draft"] == false && release["prerelease"] == false,
        "The latest release is not stable"
    );
    let version = release["tag_name"]
        .as_str()
        .and_then(|s| s.strip_prefix('v'))
        .ok_or_else(|| anyhow::anyhow!("Release version is missing"))?;
    if semver::Version::parse(version)? <= semver::Version::parse(current)? {
        return Ok(None);
    }
    let base = format!("{REPOSITORY}/releases/download/v{version}");
    let metadata = bytes(&format!("{base}/update.json"), 32768).await?;
    let signature = bytes(&format!("{base}/update.json.minisig"), 8192).await?;
    Ok(Some(verify(
        &metadata,
        std::str::from_utf8(&signature)?,
        current,
        version,
    )?))
}
pub async fn download(manifest: &Manifest) -> Result<PathBuf> {
    download_with_progress(manifest, |_, _| {}).await
}
pub async fn download_with_progress(
    manifest: &Manifest,
    report: impl Fn(u64, u64),
) -> Result<PathBuf> {
    let root = secure::private_root()?.join("updates");
    secure::no_links(&root)?;
    tokio::fs::create_dir_all(&root).await?;
    let directory = root.join(uuid::Uuid::new_v4().simple().to_string());
    tokio::fs::create_dir(&directory).await?;
    let part = directory.join("setup.part");
    let complete = directory.join(format!("CodexLocalMCP-{}-setup.exe", manifest.version));
    let result = async {
        let mut response = client()?
            .get(&manifest.url)
            .send()
            .await?
            .error_for_status()?;
        let mut file = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&part)
            .await?;
        let mut received = 0u64;
        let mut hash = Sha256::new();
        let mut last = std::time::Instant::now();
        report(0, manifest.size);
        while let Some(chunk) = response.chunk().await? {
            received += chunk.len() as u64;
            ensure!(
                received <= manifest.size,
                "The update exceeds its signed size"
            );
            hash.update(&chunk);
            file.write_all(&chunk).await?;
            if last.elapsed() >= Duration::from_millis(200) {
                report(received, manifest.size);
                last = std::time::Instant::now();
            }
        }
        file.sync_all().await?;
        drop(file);
        ensure!(
            received == manifest.size
                && format!("{:x}", hash.finalize()) == manifest.sha256.to_lowercase(),
            "The update failed signature-linked SHA256 verification"
        );
        tokio::fs::rename(&part, &complete).await?;
        report(received, manifest.size);
        Ok::<_, anyhow::Error>(complete)
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(part).await;
    }
    result
}
pub fn launch(installer: &Path, install: &Path, connected: bool) -> Result<()> {
    secure::no_links(installer)?;
    secure::no_links(install)?;
    ensure!(
        installer.starts_with(secure::root()?.join("updates"))
            && installer.extension().is_some_and(|s| s == "exe"),
        "Invalid update installer location"
    );
    // The verified installer provides progress, staging, rollback, and uninstall registration.
    runtime::command(installer)
        .kill_on_drop(false)
        .args(launch_args(install, connected))
        .spawn()?;
    Ok(())
}
/// Setup reopens the app with `--resume-connection` only when the connection
/// was running, so an update does not leave Claude disconnected.
fn launch_args(install: &Path, connected: bool) -> Vec<std::ffi::OsString> {
    vec![
        "--target".into(),
        install.into(),
        "--connection".into(),
        if connected { "running" } else { "stopped" }.into(),
    ]
}

#[cfg(test)]
mod tests {
    use super::{Manifest, REPOSITORY, launch_args, verify_with_key};
    #[test]
    fn setup_receives_the_connection_state() {
        let install = std::path::Path::new(r"C:\Program Files\Codex Local MCP");
        let running = launch_args(install, true);
        assert_eq!(running[0], "--target");
        assert_eq!(running[1], install.as_os_str());
        assert_eq!(running[2..], ["--connection", "running"]);
        assert_eq!(launch_args(install, false)[3], "stopped");
    }
    #[test]
    fn signed_metadata_rejects_tampering_wrong_key_rollback_and_foreign_urls() {
        let pair = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let other = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let mut value = Manifest {
            product: "codex-local-mcp".into(),
            version: "0.8.0".into(),
            architecture: "x64".into(),
            url: format!(
                "{REPOSITORY}/releases/download/v0.8.0/CodexLocalMCP-0.8.0-windows-x64-setup.exe"
            ),
            sha256: "a".repeat(64),
            size: 1024,
        };
        let sign = |v: &Manifest| {
            let bytes = serde_json::to_vec(v).unwrap();
            let signature = minisign::sign(
                Some(&pair.pk),
                &pair.sk,
                std::io::Cursor::new(&bytes),
                None,
                None,
            )
            .unwrap()
            .to_string();
            (bytes, signature)
        };
        let (bytes, signature) = sign(&value);
        let key = pair.pk.to_base64();
        assert!(verify_with_key(&bytes, &signature, "0.7.0", "0.8.0", &key).is_ok());
        let mut tampered = bytes.clone();
        tampered[1] = b'x';
        assert!(verify_with_key(&tampered, &signature, "0.7.0", "0.8.0", &key).is_err());
        assert!(
            verify_with_key(&bytes, &signature, "0.7.0", "0.8.0", &other.pk.to_base64()).is_err()
        );
        assert!(verify_with_key(&bytes, &signature, "0.8.0", "0.8.0", &key).is_err());
        assert!(verify_with_key(&bytes, &signature, "0.7.0", "0.9.0", &key).is_err());
        value.url = "https://example.com/setup.exe".into();
        let (bytes, signature) = sign(&value);
        assert!(verify_with_key(&bytes, &signature, "0.7.0", "0.8.0", &key).is_err());
    }
}
