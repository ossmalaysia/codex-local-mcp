use anyhow::{Result, ensure};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::Read,
    path::{Component, Path, PathBuf},
};

pub fn relative(name: &str) -> Result<PathBuf> {
    // Reject Windows syntax on all platforms, including alternate data streams.
    ensure!(
        !name.contains([':', '\0']) && !name.starts_with(['/', '\\']),
        "Path must be relative to the workspace root"
    );
    let path = PathBuf::from(name.replace('\\', "/"));
    ensure!(
        path.components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir)),
        "Path traversal is refused"
    );
    Ok(path)
}

pub fn prepare(root: &Path, name: Option<&str>) -> Result<PathBuf> {
    let slug = name
        .filter(|n| !n.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("ws-{}", uuid::Uuid::new_v4()));
    let target = root.join(relative(slug.trim())?);
    let mut existing = target.as_path();
    while !existing.exists() {
        existing = existing
            .parent()
            .ok_or_else(|| anyhow::anyhow!("Invalid workspace"))?;
    }
    ensure!(
        existing.canonicalize()?.starts_with(root),
        "Workspace resolves outside its root"
    );
    fs::create_dir_all(&target)?;
    let real = target.canonicalize()?;
    ensure!(
        real.starts_with(root),
        "Workspace resolves outside its root"
    );
    Ok(real)
}

pub fn open(root: &Path, target: &Path) -> Result<(File, PathBuf)> {
    let target = if target.is_absolute() {
        target.to_owned()
    } else {
        root.join(relative(&target.to_string_lossy())?)
    };
    #[cfg(windows)]
    {
        let s = target.to_string_lossy();
        // A drive prefix is the only permitted colon. Canonical paths may have a \\?\ prefix.
        let tail = s.strip_prefix(r"\\?\").unwrap_or(&s);
        ensure!(
            !tail.get(2..).unwrap_or("").contains(':'),
            "Alternate data streams are refused"
        );
    }
    let real = target.canonicalize()?;
    ensure!(
        real.starts_with(root),
        "Artifact resolves outside the workspace root"
    );
    let file = File::open(&real)?;
    ensure!(file.metadata()?.is_file(), "Artifact is not a regular file");
    let actual = handle_path(&file)?;
    ensure!(
        actual.starts_with(root),
        "Opened artifact is outside the workspace root"
    );
    Ok((file, actual))
}

#[cfg(windows)]
fn handle_path(file: &File) -> Result<PathBuf> {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    use windows::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{FILE_NAME_NORMALIZED, GetFinalPathNameByHandleW},
    };
    let mut buf = vec![0u16; 32768];
    // SAFETY: The borrowed file handle stays valid; buf is writable for its declared length.
    let len = unsafe {
        GetFinalPathNameByHandleW(HANDLE(file.as_raw_handle()), &mut buf, FILE_NAME_NORMALIZED)
    } as usize;
    ensure!(
        len > 0 && len < buf.len(),
        "Cannot validate opened file path"
    );
    Ok(PathBuf::from(std::ffi::OsString::from_wide(&buf[..len])))
}

#[cfg(unix)]
fn handle_path(file: &File) -> Result<PathBuf> {
    use std::os::fd::AsRawFd;
    #[cfg(target_os = "linux")]
    return Ok(fs::read_link(format!(
        "/proc/self/fd/{}",
        file.as_raw_fd()
    ))?);
    #[cfg(not(target_os = "linux"))]
    anyhow::bail!("Confined artifact reads are currently supported on Windows and Linux only");
}

pub fn read(root: &Path, target: &Path, limit: usize) -> Result<(Vec<u8>, PathBuf)> {
    let (file, real) = open(root, target)?;
    ensure!(
        file.metadata()?.len() <= limit as u64,
        "Artifact exceeds the byte limit"
    );
    let mut data = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut data)?;
    ensure!(data.len() <= limit, "Artifact grew past the byte limit");
    Ok((data, real))
}

pub type Snapshot = BTreeMap<PathBuf, (u64, std::time::SystemTime)>;
pub fn snapshot(root: &Path) -> Snapshot {
    fn walk(dir: &Path, root: &Path, depth: usize, out: &mut Snapshot, visited: &mut usize) {
        if depth > 12 || *visited >= 10_000 {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            *visited += 1;
            if *visited > 10_000 {
                break;
            }
            let Ok(meta) = fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    continue;
                } // Reparse point.
            }
            if meta.is_dir() {
                if ![
                    "node_modules",
                    ".git",
                    ".venv",
                    "venv",
                    "__pycache__",
                    ".pytest_cache",
                    ".next",
                    "dist",
                    ".codex",
                ]
                .contains(&entry.file_name().to_string_lossy().as_ref())
                {
                    walk(&entry.path(), root, depth + 1, out, visited);
                }
            } else if meta.is_file()
                && let Ok(modified) = meta.modified()
            {
                out.insert(
                    entry.path().strip_prefix(root).unwrap().to_owned(),
                    (meta.len(), modified),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, 0, &mut out, &mut 0);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_traversal_and_windows_special_paths() {
        for s in [
            "../secret",
            "a/../../secret",
            "C:\\secret",
            "//server/share",
            "x:stream",
            "\\secret",
            "a\\..\\secret",
        ] {
            assert!(relative(s).is_err(), "{s}");
        }
        assert!(relative(".").is_ok());
        assert!(relative("ws/output/a.png").is_ok());
    }
    #[test]
    fn confined_read_and_size_limit() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        fs::write(root.join("file.txt"), "hello").unwrap();
        assert_eq!(read(&root, Path::new("file.txt"), 5).unwrap().0, b"hello");
        assert!(read(&root, Path::new("file.txt"), 4).is_err());
        assert!(read(&root, Path::new("../file.txt"), 9).is_err());
    }
}
