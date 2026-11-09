//! Local Git projects that Claude may ask Codex to work on, and the Codex model
//! allowlist. The desktop only stores and validates them; the service reads the
//! `CODEX_PROJECTS` and `CODEX_ALLOWED_MODELS` variables built here.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
};

/// Bounds keep the environment block well under the Windows limit of 32,767
/// characters per variable.
pub const MAX_PROJECTS: usize = 32;
pub const MAX_CHECKS: usize = 16;
pub const MAX_MODELS: usize = 32;
const MAX_COMMAND: usize = 1024;
const MAX_PATH: usize = 1024;
const MAX_ENV: usize = 30_000;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Project {
    pub name: String,
    pub path: String,
    pub setup: String,
    pub checks: Vec<Check>,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Check {
    pub name: String,
    pub command: String,
}

/// The exact shape other components consume: `{"<name>": {"path", "setup"?, "checks"?}}`.
#[derive(Serialize)]
struct ProjectEnv<'a> {
    path: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    setup: &'a str,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    checks: BTreeMap<&'a str, &'a str>,
}

/// `^[A-Za-z0-9._-]{1,64}$`
pub fn valid_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
/// `^[A-Za-z0-9._:/-]{1,128}$`, the same characters the task options accept.
pub fn valid_model(model: &str) -> bool {
    (1..=128).contains(&model.len())
        && model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:/-".contains(&b))
}

/// Trims every field and drops check rows left completely empty, so stray
/// whitespace from the form never reaches validation or the service.
pub fn normalize(projects: Vec<Project>) -> Vec<Project> {
    projects
        .into_iter()
        .map(|p| Project {
            name: p.name.trim().into(),
            path: p.path.trim().into(),
            setup: p.setup.trim().into(),
            checks: p
                .checks
                .into_iter()
                .map(|c| Check {
                    name: c.name.trim().into(),
                    command: c.command.trim().into(),
                })
                .filter(|c| !c.name.is_empty() || !c.command.is_empty())
                .collect(),
        })
        .collect()
}
/// Trims, drops empty entries and repeats, and keeps the user's order.
pub fn normalize_models(models: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    models
        .into_iter()
        .map(|m| m.trim().to_owned())
        .filter(|m| !m.is_empty() && seen.insert(m.clone()))
        .collect()
}

fn command(text: &str, what: &str) -> Result<()> {
    ensure!(
        text.chars().count() <= MAX_COMMAND,
        "{what} must be at most {MAX_COMMAND} characters"
    );
    // A line break would let one saved command smuggle in a second one.
    ensure!(
        !text.chars().any(char::is_control),
        "{what} must be a single line"
    );
    Ok(())
}

/// `separate` lists folders a project must not overlap: the task workspace
/// (Codex can write there), the application, and its private data.
pub fn validate(
    projects: &[Project],
    models: &[String],
    default_model: &str,
    separate: &[&Path],
    overlap: impl Fn(&Path, &Path) -> bool,
) -> Result<()> {
    ensure!(
        projects.len() <= MAX_PROJECTS,
        "Add at most {MAX_PROJECTS} coding projects"
    );
    let mut names = HashSet::new();
    for project in projects {
        let name = &project.name;
        ensure!(
            valid_name(name),
            "Project names use 1 to 64 letters, digits, dots, dashes or underscores"
        );
        // Names are case-insensitive, like Windows folder names, so two
        // projects cannot differ only by case.
        ensure!(
            names.insert(name.to_ascii_lowercase()),
            "Project \"{name}\" is listed twice. Use unique project names"
        );
        validate_path(project, separate, &overlap)?;
        command(
            &project.setup,
            &format!("Project \"{name}\": the setup command"),
        )?;
        ensure!(
            project.checks.len() <= MAX_CHECKS,
            "Project \"{name}\": add at most {MAX_CHECKS} checks"
        );
        let mut checks = HashSet::new();
        for check in &project.checks {
            ensure!(
                valid_name(&check.name),
                "Project \"{name}\": check names use 1 to 64 letters, digits, dots, dashes or underscores"
            );
            ensure!(
                checks.insert(check.name.to_ascii_lowercase()),
                "Project \"{name}\": check \"{}\" is listed twice",
                check.name
            );
            ensure!(
                !check.command.is_empty(),
                "Project \"{name}\": enter a command for check \"{}\"",
                check.name
            );
            command(
                &check.command,
                &format!(
                    "Project \"{name}\": the command for check \"{}\"",
                    check.name
                ),
            )?;
        }
    }
    ensure!(
        models.len() <= MAX_MODELS,
        "Allow at most {MAX_MODELS} models"
    );
    for model in models {
        ensure!(
            valid_model(model),
            "Allowed models: \"{model}\" is not a valid model ID. Use letters, digits and . _ : / -"
        );
    }
    ensure!(
        default_model.is_empty() || models.is_empty() || models.iter().any(|m| m == default_model),
        "The default Codex model \"{default_model}\" is not in Allowed models"
    );
    ensure!(
        env(projects, models)?
            .iter()
            .all(|(_, value)| value.len() <= MAX_ENV),
        "Coding projects are too long to pass to the service. Shorten the commands or remove a project"
    );
    Ok(())
}

fn validate_path(
    project: &Project,
    separate: &[&Path],
    overlap: &impl Fn(&Path, &Path) -> bool,
) -> Result<()> {
    let name = &project.name;
    let path = PathBuf::from(&project.path);
    ensure!(
        project.path.chars().count() <= MAX_PATH,
        "Project \"{name}\": the folder path is too long"
    );
    ensure!(
        !path.components().any(|c| matches!(
            c,
            std::path::Component::ParentDir | std::path::Component::CurDir
        )),
        "Project \"{name}\": the folder path must not contain dot segments"
    );
    ensure!(
        path.is_absolute() && !project.path.starts_with(r"\\"),
        "Project \"{name}\": choose an absolute local folder"
    );
    ensure!(
        path.is_dir(),
        "Project \"{name}\": the folder {} does not exist",
        project.path
    );
    // A worktree or submodule has a `.git` file instead of a folder; both count.
    ensure!(
        std::fs::symlink_metadata(path.join(".git")).is_ok(),
        "Project \"{name}\": the folder is not a Git repository (no .git found)"
    );
    ensure!(
        !separate.iter().any(|other| overlap(&path, other)),
        "Project \"{name}\": keep the repository outside the workspace folder, the application and its private data"
    );
    Ok(())
}

/// Variables for the service. Empty settings set nothing, so the service sees
/// them as unset rather than as an empty list.
pub fn env(projects: &[Project], models: &[String]) -> Result<Vec<(&'static str, String)>> {
    let mut vars = Vec::new();
    if !projects.is_empty() {
        let map: BTreeMap<&str, ProjectEnv> = projects
            .iter()
            .map(|p| {
                (
                    p.name.as_str(),
                    ProjectEnv {
                        path: &p.path,
                        setup: &p.setup,
                        checks: p
                            .checks
                            .iter()
                            .map(|c| (c.name.as_str(), c.command.as_str()))
                            .collect(),
                    },
                )
            })
            .collect();
        vars.push(("CODEX_PROJECTS", serde_json::to_string(&map)?));
    }
    if !models.is_empty() {
        vars.push(("CODEX_ALLOWED_MODELS", models.join(",")));
    }
    Ok(vars)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn never(_: &Path, _: &Path) -> bool {
        false
    }
    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        dir
    }
    fn project(name: &str, path: &Path) -> Project {
        Project {
            name: name.into(),
            path: path.to_string_lossy().into(),
            ..Default::default()
        }
    }
    fn check(projects: &[Project], models: &[String]) -> Result<()> {
        validate(projects, models, "", &[], never)
    }
    fn message(result: Result<()>) -> String {
        result.unwrap_err().to_string()
    }

    #[test]
    fn env_matches_the_contract_exactly() {
        let projects = vec![
            Project {
                name: "web".into(),
                path: r"C:\src\web".into(),
                setup: "npm ci".into(),
                checks: vec![
                    Check {
                        name: "test".into(),
                        command: "npm test".into(),
                    },
                    Check {
                        name: "lint".into(),
                        command: "npm run lint".into(),
                    },
                ],
            },
            Project {
                name: "api".into(),
                path: r"C:\src\api".into(),
                ..Default::default()
            },
        ];
        let models = vec!["gpt-5.1-codex".to_owned(), "o4-mini".to_owned()];
        let vars = env(&projects, &models).unwrap();
        assert_eq!(vars[0].0, "CODEX_PROJECTS");
        assert_eq!(
            vars[0].1,
            r#"{"api":{"path":"C:\\src\\api"},"web":{"path":"C:\\src\\web","setup":"npm ci","checks":{"lint":"npm run lint","test":"npm test"}}}"#
        );
        let parsed: serde_json::Value = serde_json::from_str(&vars[0].1).unwrap();
        assert_eq!(parsed["web"]["checks"]["test"], "npm test");
        assert!(parsed["api"].get("setup").is_none());
        assert!(parsed["api"].get("checks").is_none());
        assert_eq!(
            vars[1],
            ("CODEX_ALLOWED_MODELS", "gpt-5.1-codex,o4-mini".to_owned())
        );
    }

    #[test]
    fn empty_settings_leave_both_variables_unset() {
        assert!(env(&[], &[]).unwrap().is_empty());
    }

    #[test]
    fn accepts_a_git_repository_with_checks() {
        let dir = repo();
        let mut p = project("my_app-2.0", dir.path());
        p.setup = "npm ci".into();
        p.checks = vec![Check {
            name: "test".into(),
            command: "npm test".into(),
        }];
        check(&[p], &["gpt-5.1-codex".into(), "openai/gpt:latest".into()]).unwrap();
    }

    #[test]
    fn accepts_a_git_file_from_a_worktree() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".git"), "gitdir: ../main/.git/worktrees/x").unwrap();
        check(&[project("wt", dir.path())], &[]).unwrap();
    }

    #[test]
    fn rejects_invalid_and_duplicate_names() {
        let dir = repo();
        for name in ["", "has space", "a/b", "ü", &"x".repeat(65)] {
            assert!(message(check(&[project(name, dir.path())], &[])).contains("Project names"));
        }
        let error = message(check(
            &[project("Web", dir.path()), project("web", dir.path())],
            &[],
        ));
        assert!(error.contains("listed twice"), "{error}");
    }

    #[test]
    fn rejects_folders_that_are_not_local_git_repositories() {
        let plain = tempfile::tempdir().unwrap();
        assert!(
            message(check(&[project("a", plain.path())], &[])).contains("not a Git repository")
        );
        let missing = plain.path().join("missing");
        assert!(message(check(&[project("a", &missing)], &[])).contains("does not exist"));
        assert!(
            message(check(&[project("a", Path::new("relative/repo"))], &[]))
                .contains("absolute local folder")
        );
        let dotted = repo();
        let path = dotted
            .path()
            .join("..")
            .join(dotted.path().file_name().unwrap());
        assert!(message(check(&[project("a", &path)], &[])).contains("dot segments"));
        let error = message(check(
            &[project("a", Path::new(r"\\server\share\repo"))],
            &[],
        ));
        assert!(
            error.contains("absolute local folder") || error.contains("does not exist"),
            "{error}"
        );
    }

    #[test]
    fn rejects_a_repository_inside_a_separate_folder() {
        let dir = repo();
        let error = message(validate(
            &[project("a", dir.path())],
            &[],
            "",
            &[dir.path()],
            |a, b| a == b,
        ));
        assert!(error.contains("outside the workspace"), "{error}");
    }

    #[test]
    fn rejects_bad_checks_and_multi_line_commands() {
        let dir = repo();
        let mut p = project("a", dir.path());
        p.checks = vec![Check {
            name: "bad name".into(),
            command: "npm test".into(),
        }];
        assert!(message(check(&[p.clone()], &[])).contains("check names"));
        p.checks = vec![
            Check {
                name: "test".into(),
                command: "npm test".into(),
            },
            Check {
                name: "TEST".into(),
                command: "npm test".into(),
            },
        ];
        assert!(message(check(&[p.clone()], &[])).contains("listed twice"));
        p.checks = vec![Check {
            name: "test".into(),
            command: String::new(),
        }];
        assert!(message(check(&[p.clone()], &[])).contains("enter a command"));
        p.checks = vec![];
        p.setup = "npm ci\nrm -rf /".into();
        assert!(message(check(&[p], &[])).contains("single line"));
    }

    #[test]
    fn rejects_invalid_models_and_a_default_outside_the_list() {
        for model in ["has space", "a,b", "ü", &"m".repeat(129)] {
            let error = message(check(&[], &[model.to_owned()]));
            assert!(error.contains("not a valid model ID"), "{error}");
        }
        let error = message(validate(&[], &["o4-mini".into()], "gpt-5", &[], never));
        assert!(error.contains("not in Allowed models"), "{error}");
        validate(&[], &["gpt-5".into()], "gpt-5", &[], never).unwrap();
        validate(&[], &[], "gpt-5", &[], never).unwrap();
    }

    #[test]
    fn normalizing_trims_and_drops_empty_rows() {
        let projects = normalize(vec![Project {
            name: " web ".into(),
            path: " C:/src/web ".into(),
            setup: "  ".into(),
            checks: vec![
                Check::default(),
                Check {
                    name: " test ".into(),
                    command: " npm test ".into(),
                },
            ],
        }]);
        assert_eq!(projects[0].name, "web");
        assert_eq!(projects[0].path, "C:/src/web");
        assert_eq!(projects[0].setup, "");
        assert_eq!(
            projects[0].checks,
            vec![Check {
                name: "test".into(),
                command: "npm test".into()
            }]
        );
        assert_eq!(
            normalize_models(vec![" a ".into(), "".into(), "b".into(), "a".into()]),
            vec!["a", "b"]
        );
    }
}
