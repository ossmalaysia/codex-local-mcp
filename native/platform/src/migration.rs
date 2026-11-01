use crate::secure;
use anyhow::{Result, ensure};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Path, PathBuf},
};

/// Remove only unchanged legacy files listed by the release builder.
pub fn cleanup(install: &Path) -> Result<()> {
    let manifest = install.join("runtime/migration.json");
    secure::no_links(&manifest)?;
    if !manifest.exists() {
        return Ok(());
    }
    ensure!(
        manifest.metadata()?.len() <= 131072,
        "Migration inventory exceeds its size limit"
    );
    let entries: BTreeMap<String, String> =
        serde_json::from_str(std::fs::read_to_string(&manifest)?.trim_start_matches('\u{feff}'))?;
    ensure!(
        entries.len() <= 512,
        "Migration inventory contains too many files"
    );
    let mut directories = Vec::new();
    for (relative, expected) in entries {
        ensure!(
            (relative.starts_with("app/")
                || relative.starts_with("runtime/node/")
                || [
                    "CodexMCP.exe.config",
                    "CodexMCP.pdb",
                    "verify-installed.mjs"
                ]
                .contains(&relative.as_str()))
                && !relative.contains(['\\', ':'])
                && relative
                    .split('/')
                    .all(|p| !p.is_empty() && p != "." && p != ".."),
            "Invalid migration inventory path"
        );
        let path = install.join(relative);
        secure::no_links(&path)?;
        if !path.exists() {
            continue;
        }
        ensure!(path.is_file(), "A migration file was replaced by a folder");
        let mut file = std::fs::File::open(&path)?;
        let mut hash = Sha256::new();
        let mut buf = [0; 65536];
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hash.update(&buf[..n]);
        }
        drop(file);
        if format!("{:x}", hash.finalize()) == expected {
            std::fs::remove_file(&path)?;
            let mut parent = path.parent();
            while let Some(p) = parent {
                if p == install {
                    break;
                }
                directories.push(p.to_path_buf());
                parent = p.parent();
            }
        }
    }
    directories.sort_by_key(|p: &PathBuf| std::cmp::Reverse(p.components().count()));
    directories.dedup();
    for directory in directories {
        secure::no_links(&directory)?;
        let _ = std::fs::remove_dir(directory);
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::cleanup;
    use sha2::{Digest, Sha256};
    #[test]
    fn preserves_changed_and_unlisted_files_during_node_removal() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::fs::create_dir_all(root.join("runtime/node")).unwrap();
        std::fs::create_dir_all(root.join("app/dist")).unwrap();
        std::fs::write(root.join("runtime/node/node.exe"), b"owned").unwrap();
        std::fs::write(root.join("app/dist/index.js"), b"user-modified").unwrap();
        std::fs::write(root.join("app/notes.txt"), b"user").unwrap();
        let entries = serde_json::json!({"runtime/node/node.exe":format!("{:x}",Sha256::digest(b"owned")),"app/dist/index.js":format!("{:x}",Sha256::digest(b"original"))});
        std::fs::write(root.join("runtime/migration.json"), entries.to_string()).unwrap();
        cleanup(root).unwrap();
        assert!(!root.join("runtime/node/node.exe").exists());
        assert!(root.join("app/dist/index.js").exists());
        assert!(root.join("app/notes.txt").exists());
    }
    #[test]
    fn rejects_migration_traversal() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("runtime")).unwrap();
        std::fs::write(
            temp.path().join("runtime/migration.json"),
            r#"{"app/../user.txt":"hash"}"#,
        )
        .unwrap();
        assert!(cleanup(temp.path()).is_err());
    }
}
