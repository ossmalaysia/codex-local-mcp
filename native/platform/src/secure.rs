use anyhow::{Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub fn root() -> Result<PathBuf> {
    Ok(PathBuf::from(
        std::env::var_os("LOCALAPPDATA")
            .ok_or_else(|| anyhow::anyhow!("Windows local application data is unavailable"))?,
    )
    .join("CodexLocalMCPData"))
}
pub fn no_links(path: &Path) -> Result<()> {
    for part in path.ancestors() {
        if let Ok(meta) = fs::symlink_metadata(part) {
            ensure!(
                !meta.file_type().is_symlink(),
                "Application paths must not contain links"
            );
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                ensure!(
                    meta.file_attributes() & 0x400 == 0,
                    "Application paths must not contain reparse points"
                );
            }
        }
    }
    Ok(())
}
pub fn private_root() -> Result<PathBuf> {
    let root = root()?;
    no_links(&root)?;
    fs::create_dir_all(&root)?;
    #[cfg(windows)]
    {
        let system =
            PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
                .join("System32");
        use std::os::windows::process::CommandExt;
        let identity = std::process::Command::new(system.join("whoami.exe"))
            .args(["/user", "/fo", "csv", "/nh"])
            .creation_flags(0x08000000)
            .output()?;
        ensure!(
            identity.status.success(),
            "Cannot identify the Windows account"
        );
        let text = String::from_utf8_lossy(&identity.stdout);
        let sid = text
            .split('"')
            .find(|s| {
                s.starts_with("S-1-")
                    && s.len() < 256
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || b == b'S' || b == b'-')
            })
            .ok_or_else(|| anyhow::anyhow!("Invalid Windows account identifier"))?;
        let status = std::process::Command::new(system.join("icacls.exe"))
            .arg(&root)
            .args([
                "/inheritance:r",
                "/grant:r",
                &format!("*{sid}:(OI)(CI)F"),
                "*S-1-5-18:(OI)(CI)F",
            ])
            .creation_flags(0x08000000)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()?;
        ensure!(
            status.success(),
            "Cannot secure the application data folder"
        );
    }
    Ok(root)
}

#[cfg(windows)]
fn dpapi(data: &[u8], decrypt: bool) -> Result<Vec<u8>> {
    use windows::Win32::{
        Foundation::{HLOCAL, LocalFree},
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len().try_into()?,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: DPAPI borrows input for this call and allocates output with LocalAlloc.
    unsafe {
        if decrypt {
            CryptUnprotectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )?;
        } else {
            CryptProtectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )?;
        }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
        LocalFree(Some(HLOCAL(output.pbData as *mut _)));
        Ok(bytes)
    }
}
#[cfg(not(windows))]
fn dpapi(_: &[u8], _: bool) -> Result<Vec<u8>> {
    anyhow::bail!("Windows DPAPI is required")
}
pub fn protect(data: &[u8]) -> Result<String> {
    Ok(STANDARD.encode(dpapi(data, false)?))
}
pub fn unprotect(blob: &str) -> Result<zeroize::Zeroizing<Vec<u8>>> {
    if blob.is_empty() {
        return Ok(zeroize::Zeroizing::new(vec![]));
    }
    Ok(zeroize::Zeroizing::new(dpapi(
        &STANDARD.decode(blob)?,
        true,
    )?))
}
pub fn atomic(path: &Path, data: &[u8]) -> Result<()> {
    no_links(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Invalid settings path"))?;
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(".new-{}", uuid::Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)?;
    file.write_all(data)?;
    file.sync_all()?;
    drop(file);
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            Win32::Storage::FileSystem::{
                MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
            },
            core::PCWSTR,
        };
        let a: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
        let b: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            MoveFileExW(
                PCWSTR(a.as_ptr()),
                PCWSTR(b.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
        .is_err()
        {
            let _ = fs::remove_file(&temp);
            anyhow::bail!("Cannot save settings atomically");
        }
    }
    #[cfg(not(windows))]
    fs::rename(temp, path)?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn dpapi_roundtrip_matches_existing_store_format() {
        let sealed = protect(b"migration password").unwrap();
        assert_eq!(&**unprotect(&sealed).unwrap(), b"migration password");
    }
    #[test]
    fn atomic_replaces_existing_file() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("settings.json");
        atomic(&p, b"old").unwrap();
        atomic(&p, b"new").unwrap();
        assert_eq!(fs::read(p).unwrap(), b"new");
    }
}
