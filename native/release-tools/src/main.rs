use anyhow::{Result, ensure};
use codex_mcp_platform::secure;
use minisign::{KeyPair, SecretKey, SecretKeyBox};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
};

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let key_file = secure::private_root()?.join("release-signing-key.dpapi");
    match args.get(1).map(String::as_str) {
        Some("check") | Some("download") => {
            let current = args
                .get(2)
                .ok_or_else(|| anyhow::anyhow!("Specify the installed version"))?;
            tokio::runtime::Runtime::new()?.block_on(async {
                if let Some(manifest) = codex_mcp_platform::updates::check(current).await? {
                    if args[1] == "download" {
                        codex_mcp_platform::updates::download(&manifest).await?;
                    }
                    println!("Verified signed update: {}", manifest.version);
                } else {
                    println!("No newer stable update");
                }
                Ok::<_, anyhow::Error>(())
            })?;
        }
        Some("verify") => {
            use sha2::{Digest, Sha256};
            use std::io::Read;
            let metadata = PathBuf::from(
                args.get(2)
                    .ok_or_else(|| anyhow::anyhow!("Specify metadata"))?,
            );
            let bytes = fs::read(&metadata)?;
            let value: serde_json::Value = serde_json::from_slice(&bytes)?;
            let signature = fs::read_to_string(format!("{}.minisig", metadata.display()))?;
            let manifest = codex_mcp_platform::updates::verify(
                &bytes,
                &signature,
                "0.0.0",
                value["version"].as_str().unwrap_or(""),
            )?;
            let installer = args
                .get(3)
                .ok_or_else(|| anyhow::anyhow!("Specify installer"))?;
            let mut file = fs::File::open(installer)?;
            ensure!(
                file.metadata()?.len() == manifest.size,
                "Installer size mismatch"
            );
            let mut hash = Sha256::new();
            let mut buffer = [0; 65536];
            loop {
                let n = file.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                hash.update(&buffer[..n]);
            }
            ensure!(
                format!("{:x}", hash.finalize()) == manifest.sha256,
                "Installer hash mismatch"
            );
            println!("Signed metadata and installer verified");
        }
        Some("keygen") => {
            ensure!(!key_file.exists(), "A signing key already exists");
            let pair = KeyPair::generate_unencrypted_keypair()?;
            let secret = zeroize::Zeroizing::new(pair.sk.to_box(None)?.to_string());
            secure::atomic(&key_file, secure::protect(secret.as_bytes())?.as_bytes())?;
            let public = args
                .get(2)
                .ok_or_else(|| anyhow::anyhow!("Specify the public key output path"))?;
            secure::atomic(
                &PathBuf::from(public),
                format!("{}\n", pair.pk.to_base64()).as_bytes(),
            )?;
            println!("Public key saved. Private key is protected with Windows DPAPI.");
        }
        Some("github-secret") => {
            let sealed = fs::read_to_string(&key_file)?;
            let secret = secure::unprotect(&sealed)?;
            let mut child = Command::new("gh")
                .args([
                    "secret",
                    "set",
                    "WINDOWS_UPDATE_SIGNING_KEY",
                    "--repo",
                    "ossmalaysia/codex-local-mcp",
                ])
                .stdin(Stdio::piped())
                .spawn()?;
            child.stdin.take().unwrap().write_all(&secret)?;
            ensure!(child.wait()?.success(), "GitHub secret creation failed");
        }
        Some("sign") => {
            let path = PathBuf::from(
                args.get(2)
                    .ok_or_else(|| anyhow::anyhow!("Specify a metadata file"))?,
            );
            let secret = if let Ok(value) = std::env::var("WINDOWS_UPDATE_SIGNING_KEY") {
                zeroize::Zeroizing::new(value.into_bytes())
            } else {
                secure::unprotect(&fs::read_to_string(key_file)?)?
            };
            let sk = SecretKey::from_unencrypted_box(SecretKeyBox::from_string(
                std::str::from_utf8(&secret)?,
            )?)?;
            let public = minisign::PublicKey::from_secret_key(&sk)?;
            ensure!(
                public.to_base64() == include_str!("../../platform/update-public-key.txt").trim(),
                "The release key does not match the application's pinned public key"
            );
            let signature = minisign::sign(
                Some(&public),
                &sk,
                fs::File::open(&path)?,
                Some("Codex Local MCP Windows update"),
                None,
            )?;
            secure::atomic(
                &PathBuf::from(format!("{}.minisig", path.display())),
                signature.to_string().as_bytes(),
            )?;
            println!("Update metadata signed.");
        }
        _ => anyhow::bail!("Commands: keygen <public-path>, github-secret, sign <metadata-path>"),
    }
    Ok(())
}
