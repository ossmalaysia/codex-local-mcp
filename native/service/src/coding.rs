//! codex_task: a coding task on a real git project. Fetch the caller's ref into
//! a fresh worktree of the user's clone, let Codex work there inside its
//! sandbox, and hand back its final message plus a patch. Nothing is pushed.
use crate::{
    artifacts,
    config::Config,
    gitwork,
    jobs::{Job, Jobs},
    process, projects, workspace,
};
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

pub struct Input {
    pub project: projects::Project,
    pub reference: String,
    pub task: String,
    pub review: bool,
    pub acceptance: Option<String>,
    pub checks: Vec<(String, String)>,
    pub return_patch: bool,
}

/// Everything is checked here, so a bad request never becomes a job.
pub fn validate(config: &Config, args: &Value) -> Result<Input> {
    let task = args["task"].as_str().unwrap_or_default();
    if task.is_empty() {
        bail!("task is required");
    }
    anyhow::ensure!(task.len() <= 1_000_000, "Task exceeds the byte limit");
    let mut names: Vec<String> = Vec::new();
    for name in args["checks"].as_array().into_iter().flatten() {
        let name = name.as_str().unwrap_or_default().to_owned();
        if !names.contains(&name) {
            names.push(name);
        }
    }
    let project = projects::resolve(
        &config.projects,
        args["project"].as_str().unwrap_or_default(),
        &names,
    )?;
    let reference = args["ref"].as_str().unwrap_or_default();
    projects::validate_ref(reference)?;
    if let Some(model) = args["model"].as_str()
        && !model.is_empty()
        && (model.len() > 128
            || !model
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:/-".contains(&b)))
    {
        bail!(
            "Refusing to pass model \"{model}\": only letters, digits and . _ : / - are allowed."
        );
    }
    let checks = names
        .into_iter()
        .map(|name| {
            let command = project
                .checks
                .iter()
                .find(|(c, _)| *c == name)
                .map(|(_, command)| command.clone())
                .unwrap_or_default();
            (name, command)
        })
        .collect();
    Ok(Input {
        reference: reference.into(),
        task: task.into(),
        review: args["mode"].as_str() == Some("review"),
        acceptance: args["acceptance"]
            .as_str()
            .filter(|a| !a.is_empty())
            .map(str::to_owned),
        checks,
        return_patch: args["return"].as_str() != Some("summary"),
        project,
    })
}

/// The task goes to Codex as written. The only additions are the caller's own
/// acceptance text and the project's configured setup and check commands.
///
/// Setup and checks are repository code chosen by the caller, so they are never
/// run by this service, which works outside the Codex sandbox. Codex runs them
/// inside its sandbox and reports the outcome itself; see SECURITY.md.
pub fn prompt(
    task: &str,
    acceptance: Option<&str>,
    setup: Option<&str>,
    checks: &[(String, String)],
) -> String {
    let mut parts = vec![task.to_owned()];
    if let Some(acceptance) = acceptance {
        parts.push(format!("Done when:\n{acceptance}"));
    }
    if let Some(setup) = setup {
        parts.push(format!("First run: {setup}"));
    }
    if !checks.is_empty() {
        let lines: Vec<_> = checks.iter().map(|(n, c)| format!("- {n}: {c}")).collect();
        parts.push(format!(
            "Before finishing, run these checks and report pass/fail:\n{}",
            lines.join("\n")
        ));
    }
    parts.join("\n\n")
}

/// Package managers write their caches inside a per-project folder that the
/// sandbox allows, so installs work and later tasks reuse earlier downloads.
pub fn cache_env(cache: &Path) -> Vec<(String, String)> {
    [
        ("npm_config_cache", "npm"),
        ("YARN_CACHE_FOLDER", "yarn"),
        ("npm_config_store_dir", "pnpm-store"),
        ("PNPM_STORE_DIR", "pnpm-store"),
        ("PIP_CACHE_DIR", "pip"),
        ("UV_CACHE_DIR", "uv"),
    ]
    .into_iter()
    .map(|(key, dir)| {
        (
            key.to_owned(),
            gitwork::plain(&cache.join(dir))
                .to_string_lossy()
                .into_owned(),
        )
    })
    .collect()
}

pub async fn execute(
    jobs: &Arc<Jobs>,
    job: &Arc<Job>,
    input: Input,
    timeout: u64,
) -> Result<Value> {
    let started = Instant::now();
    let config = &jobs.config;
    // job.workspace is <root>/tasks/<project>, created and confined at start.
    let dir = job.workspace.clone();
    let worktree = dir.join(&job.id);
    // Both outside the worktree, so neither ends up in the patch, and outside
    // anything the sandbox lets Codex write.
    let last_message = dir.join(format!("{}.last.md", job.id));
    let patch_file = dir.join(format!("{}.patch", job.id));
    jobs.phase(job, "preparing");
    let result = async {
        let base =
            gitwork::create_worktree(config, &input.project.path, &input.reference, &worktree)
                .await?;
        let cache = workspace::prepare(
            &config.root,
            Some(&format!(".cache/{}", input.project.name)),
        )?;
        let permit = tokio::select! {
            permit = jobs.runs.clone().acquire_owned() => permit?,
            _ = jobs.cancel.cancelled() => bail!("Server stopped"),
        };
        jobs.phase(job, "running");
        let report_jobs = jobs.clone();
        let report_job = job.clone();
        let report = Arc::new(move |event| report_jobs.progress(&report_job, event));
        let extra = process::Extra {
            read_only: input.review,
            writable: if input.review {
                vec![]
            } else {
                vec![gitwork::plain(&cache).to_string_lossy().into_owned()]
            },
            env: cache_env(&cache),
            last_message: Some(gitwork::plain(&last_message)),
        };
        let run = process::run_with(
            config,
            &gitwork::plain(&worktree),
            prompt(
                &input.task,
                input.acceptance.as_deref(),
                input.project.setup.as_deref(),
                &input.checks,
            ),
            timeout,
            &job.options,
            jobs.cancel.child_token(),
            report,
            &extra,
        )
        .await?;
        drop(permit);
        jobs.phase(job, "collecting_files");
        let summary = workspace::read(&config.root, &last_message, 1_000_000)
            .ok()
            .map(|(data, _)| String::from_utf8_lossy(&data).trim().to_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                let parts: Vec<_> = [
                    run.stdout.trim().to_owned(),
                    if run.stderr.trim().is_empty() {
                        String::new()
                    } else {
                        format!("[stderr]\n{}", run.stderr.trim())
                    },
                ]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect();
                if parts.is_empty() {
                    "(codex produced no output)".into()
                } else {
                    parts.join("\n\n")
                }
            });
        let mut report = Report {
            job_id: job.id.clone(),
            project: input.project.name.clone(),
            reference: input.reference.clone(),
            base: base.clone(),
            review: input.review,
            code: run.code,
            timed_out: run.timed_out,
            duration: 0.0,
            summary: cap(&summary, config.output),
            diffstat: String::new(),
            checks: input.checks.clone(),
            patch_file: None,
            patch_bytes: 0,
            patch: None,
            patch_note: String::new(),
        };
        if !input.review {
            report.diffstat = gitwork::collect_patch(config, &worktree, &base, &patch_file)
                .await?
                .trim()
                .to_owned();
            report.patch_bytes = std::fs::metadata(&patch_file)?.len();
            report.patch_file = Some(patch_file.clone());
            if !input.return_patch {
                report.patch_note = "not inlined because return is \"summary\"".into();
            } else if report.patch_bytes > config.max_patch as u64 {
                report.patch_note = format!(
                    "not inlined: {} bytes is over the {}-character budget (CODEX_MAX_PATCH_CHARS)",
                    report.patch_bytes, config.max_patch
                );
            } else {
                // A UTF-8 file of N bytes decodes to at most N characters.
                let (data, _) = workspace::read(&config.root, &patch_file, config.max_patch)?;
                report.patch = Some(String::from_utf8_lossy(&data).into_owned());
            }
        }
        report.duration = started.elapsed().as_secs_f64();
        Ok(report.format())
    }
    .await;
    // The patch and final message are saved; the checkout is not needed. This
    // also runs when the fetch or checkout failed part-way.
    gitwork::remove_worktree(config, &input.project.path, &worktree).await;
    result
}

/// Keep the head and tail of long text, as the TypeScript service does.
fn cap(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_owned();
    }
    let half = max / 2;
    let head: String = text.chars().take(half).collect();
    let tail: String = text.chars().skip(count - half).collect();
    format!(
        "{head}\n\n...[{} characters omitted]...\n\n{tail}",
        count - max
    )
}

struct Report {
    job_id: String,
    project: String,
    reference: String,
    base: String,
    review: bool,
    code: Option<i32>,
    timed_out: bool,
    duration: f64,
    summary: String,
    diffstat: String,
    checks: Vec<(String, String)>,
    patch_file: Option<PathBuf>,
    patch_bytes: u64,
    patch: Option<String>,
    patch_note: String,
}

impl Report {
    /// The header lines are stable and machine-readable, and match the
    /// TypeScript service, so a calling agent can apply the patch on `base`.
    fn format(&self) -> Value {
        let failed = self.timed_out || self.code != Some(0);
        let header = format!(
            "status: {}\njob_id: {}\nproject: {}\nref: {}\nbase: {}\nexit code: {}{}\nduration: {:.1}s",
            if failed { "failed" } else { "completed" },
            self.job_id,
            self.project,
            self.reference,
            self.base,
            self.code.map_or("n/a".into(), |c| c.to_string()),
            if self.timed_out {
                " (TIMED OUT - process killed)"
            } else {
                ""
            },
            self.duration
        );
        let empty = !self.review && self.patch_bytes == 0;
        let diffstat = if self.review {
            "(review mode: no patch)".to_owned()
        } else if empty {
            "(no changes)".into()
        } else {
            self.diffstat.clone()
        };
        let checks = if self.checks.is_empty() {
            "(none requested)".to_owned()
        } else {
            let lines: Vec<_> = self
                .checks
                .iter()
                .map(|(n, c)| format!("- {n}: {c}"))
                .collect();
            format!(
                "{}\nResults are reported by Codex in the summary (not independently verified).",
                lines.join("\n")
            )
        };
        let patch = if self.review {
            "(review mode: no patch)".to_owned()
        } else if empty {
            "(no changes)".into()
        } else if let Some(patch) = &self.patch {
            patch.clone()
        } else {
            format!(
                "Saved to {} ({} bytes), {}. Fetch it through the resource link below, or with codex_read_artifact.",
                gitwork::plain(self.patch_file.as_deref().unwrap_or(Path::new(""))).display(),
                self.patch_bytes,
                self.patch_note
            )
        };
        let mut content = vec![artifacts::text(format!(
            "{header}\n\n--- summary ---\n{}\n\n--- diffstat ---\n{diffstat}\n\n--- checks ---\n{checks}\n\n--- patch ---\n{patch}",
            self.summary
        ))];
        // The saved patch stays reachable whether or not it was inlined.
        if let Some(file) = &self.patch_file
            && !empty
            && let Ok(uri) = url::Url::from_file_path(gitwork::plain(file))
        {
            content.push(json!({
                "type": "resource_link",
                "uri": uri.as_str(),
                "name": format!("{}.patch", self.job_id),
                "mimeType": "text/x-diff",
                "description": format!("{} bytes; apply with git apply on top of {}", self.patch_bytes, self.base),
            }));
        }
        json!({"content": content, "isError": failed})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_is_the_task_plus_documented_additions() {
        assert_eq!(prompt("Fix it", None, None, &[]), "Fix it");
        assert_eq!(
            prompt(
                "EDIT_REPO please",
                Some("tests pass"),
                Some("npm ci"),
                &[("test".into(), "npm test".into())]
            ),
            "EDIT_REPO please\n\nDone when:\ntests pass\n\nFirst run: npm ci\n\nBefore finishing, run these checks and report pass/fail:\n- test: npm test"
        );
    }

    #[test]
    fn caches_live_under_the_project_cache() {
        let env = cache_env(Path::new("/root/.cache/demo"));
        assert!(
            env.iter()
                .any(|(k, v)| k == "npm_config_cache" && v.ends_with("npm"))
        );
        assert!(env.iter().all(|(_, v)| v.starts_with("/root/.cache/demo")));
    }

    #[test]
    fn long_summaries_keep_head_and_tail() {
        assert_eq!(cap("abc", 10), "abc");
        let capped = cap("abcdefghij", 4);
        assert!(capped.starts_with("ab\n\n...[6 characters omitted]..."));
        assert!(capped.ends_with("ij"));
    }
}
