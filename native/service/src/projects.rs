//! Local git projects that codex_task may work on, from CODEX_PROJECTS:
//! `{"<name>": {"path": "<absolute clone>", "setup": "<cmd>", "checks": {"<check>": "<cmd>"}}}`.
//! The desktop app writes exactly this shape. A malformed value never stops the
//! service: it is reported, readably, by the two tools that need it.
use anyhow::{Result, bail, ensure};
use serde_json::Value;
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Clone, Debug)]
pub struct Project {
    pub name: String,
    /// Absolute path to the user's clone. Never shown to callers.
    pub path: PathBuf,
    pub setup: Option<String>,
    /// Sorted by name, as codex_projects lists them in both implementations.
    pub checks: Vec<(String, String)>,
}

pub type Projects = BTreeMap<String, Project>;

/// Project and check names become path segments and prompt labels. "." and
/// ".." match the characters but would climb out as a path segment.
pub fn valid_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && name != "."
        && name != ".."
}

/// Refs reach git as an argument. No leading "-" (an option), no ".." (a range
/// or a path climb), and no ":" or "+" (a refspec that writes local refs).
pub fn validate_ref(reference: &str) -> Result<()> {
    let shown: String = reference.chars().take(200).collect();
    ensure!(
        (1..=200).contains(&reference.len())
            && reference
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
            && !reference.starts_with('-')
            && !reference.contains("..")
            && !reference.ends_with('/')
            && !reference.ends_with(".lock"),
        "Invalid ref \"{shown}\": use a branch, tag or commit made of letters, digits and . _ / -, not starting with '-' and without '..'."
    );
    Ok(())
}

pub fn parse(raw: &str) -> Result<Projects, String> {
    if raw.trim().is_empty() {
        return Ok(Projects::new());
    }
    let value: Value =
        serde_json::from_str(raw).map_err(|_| "CODEX_PROJECTS is not valid JSON.".to_owned())?;
    let Some(entries) = value.as_object() else {
        return Err("CODEX_PROJECTS must be a JSON object of project names.".into());
    };
    let mut projects = Projects::new();
    for (name, entry) in entries {
        let shown: String = name.chars().take(64).collect();
        let fail = |why: &str| Err(format!("CODEX_PROJECTS: project \"{shown}\" {why}"));
        if !valid_name(name) {
            return fail("has an invalid name; use 1-64 letters, digits, '.', '_' or '-'.");
        }
        let Some(entry) = entry.as_object() else {
            return fail("must be an object with a \"path\".");
        };
        if let Some(key) = entry
            .keys()
            .find(|k| !["path", "setup", "checks"].contains(&k.as_str()))
        {
            return fail(&format!("has an unknown field \"{key}\"."));
        }
        let path = match entry.get("path").and_then(Value::as_str) {
            Some(p) if PathBuf::from(p).is_absolute() => PathBuf::from(p),
            _ => return fail("needs \"path\": an absolute path to a local git clone."),
        };
        let setup = match entry.get("setup") {
            None => None,
            Some(Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
            Some(_) => return fail("has a \"setup\" that is not a non-empty string."),
        };
        let mut checks = Vec::new();
        match entry.get("checks") {
            None => {}
            Some(Value::Object(map)) => {
                for (check, command) in map {
                    if !valid_name(check) {
                        let shown: String = check.chars().take(64).collect();
                        return fail(&format!("has an invalid check name \"{shown}\"."));
                    }
                    match command.as_str() {
                        Some(c) if !c.trim().is_empty() => checks.push((check.clone(), c.into())),
                        _ => {
                            return fail(&format!(
                                "has check \"{check}\" whose command is not a non-empty string."
                            ));
                        }
                    }
                }
            }
            Some(_) => return fail("has \"checks\" that is not an object of commands."),
        }
        checks.sort();
        projects.insert(
            name.clone(),
            Project {
                name: name.clone(),
                path,
                setup,
                checks,
            },
        );
    }
    Ok(projects)
}

/// Look up a project and its requested checks, failing before any job starts.
pub fn resolve(
    projects: &Result<Projects, String>,
    name: &str,
    checks: &[String],
) -> Result<Project> {
    let projects = projects.as_ref().map_err(|e| anyhow::anyhow!("{e}"))?;
    let shown: String = name.chars().take(64).collect();
    let Some(project) = projects.get(name) else {
        if projects.is_empty() {
            bail!("Unknown project \"{shown}\". No projects are configured (CODEX_PROJECTS).");
        }
        bail!(
            "Unknown project \"{shown}\". Configured projects: {}.",
            projects.keys().cloned().collect::<Vec<_>>().join(", ")
        );
    };
    for check in checks {
        if !project.checks.iter().any(|(c, _)| c == check) {
            let shown: String = check.chars().take(64).collect();
            if project.checks.is_empty() {
                bail!(
                    "Unknown check \"{shown}\" for project \"{name}\". This project has no checks configured."
                );
            }
            bail!(
                "Unknown check \"{shown}\" for project \"{name}\". Configured checks: {}.",
                project
                    .checks
                    .iter()
                    .map(|(c, _)| c.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
    }
    // Stated without the path: callers never learn where the clone lives.
    ensure!(
        project.path.is_dir(),
        "Project \"{name}\" points to a folder that does not exist on this computer."
    );
    Ok(project.clone())
}

/// What codex_projects shows: names and capabilities, never local paths.
pub fn describe(projects: &Result<Projects, String>) -> Result<String> {
    let projects = projects.as_ref().map_err(|e| anyhow::anyhow!("{e}"))?;
    if projects.is_empty() {
        return Ok(
            "No projects are configured. Add local git clones to CODEX_PROJECTS to use codex_task."
                .into(),
        );
    }
    Ok(projects
        .values()
        .map(|p| {
            let checks: Vec<_> = p.checks.iter().map(|(c, _)| c.as_str()).collect();
            format!(
                "project: {}\nchecks: {}\nsetup: {}",
                p.name,
                if checks.is_empty() {
                    "(none)".into()
                } else {
                    checks.join(", ")
                },
                if p.setup.is_some() { "defined" } else { "none" }
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn absolute() -> String {
        std::env::temp_dir().to_string_lossy().into_owned()
    }

    #[test]
    fn names_and_refs() {
        for good in ["demo", "my.project_1-a", "A"] {
            assert!(valid_name(good), "{good}");
        }
        for bad in ["", ".", "..", "a b", "a/b", &"x".repeat(65)] {
            assert!(!valid_name(bad), "{bad}");
        }
        for good in ["main", "feature/x", "v1.2.3", "0123abcd", "release-1_2"] {
            assert!(validate_ref(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "-uupload-pack=x",
            "a..b",
            "main:refs/heads/x",
            "+main",
            "a b",
            "x/",
            "x.lock",
            &"x".repeat(201),
        ] {
            assert!(validate_ref(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn parses_and_reports_problems() {
        assert!(parse("").unwrap().is_empty());
        let path = absolute();
        let raw = serde_json::json!({"demo":{"path":path,"setup":"npm ci","checks":{"test":"npm test","lint":"npm run lint"}},"plain":{"path":path}}).to_string();
        let projects = parse(&raw).unwrap();
        assert_eq!(projects["demo"].checks[0].0, "lint");
        assert_eq!(projects["demo"].checks[1].0, "test");
        let listed = describe(&Ok(projects.clone())).unwrap();
        assert!(listed.contains("project: demo\nchecks: lint, test\nsetup: defined"));
        assert!(listed.contains("project: plain\nchecks: (none)\nsetup: none"));
        assert!(!listed.contains(&path));
        let ok = Ok(projects);
        assert!(resolve(&ok, "demo", &["test".into()]).is_ok());
        let unknown = resolve(&ok, "nope", &[]).unwrap_err().to_string();
        assert!(unknown.contains("Configured projects: demo, plain"));
        let check = resolve(&ok, "demo", &["deploy".into()])
            .unwrap_err()
            .to_string();
        assert!(check.contains("Configured checks: lint, test"));

        for (raw, message) in [
            ("{not json".to_owned(), "not valid JSON"),
            ("[]".to_owned(), "must be a JSON object"),
            (r#"{"..":{"path":"/x"}}"#.to_owned(), "invalid name"),
            (
                r#"{"demo":{"path":"relative/path"}}"#.to_owned(),
                "absolute path",
            ),
            (r#"{"demo":"/x"}"#.to_owned(), "must be an object"),
            (
                serde_json::json!({"demo":{"path":path,"setup":3}}).to_string(),
                "setup",
            ),
            (
                serde_json::json!({"demo":{"path":path,"checks":{"a b":"x"}}}).to_string(),
                "invalid check name",
            ),
            (
                serde_json::json!({"demo":{"path":path,"extra":true}}).to_string(),
                "unknown field \"extra\"",
            ),
        ] {
            let error = parse(&raw).unwrap_err();
            assert!(error.contains(message), "{raw}: {error}");
            assert!(
                describe(&Err(error.clone()))
                    .unwrap_err()
                    .to_string()
                    .contains(message)
            );
        }
    }
}
