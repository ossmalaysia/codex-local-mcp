use crate::{activity, artifacts, config::Config, process, workspace};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio::sync::{Notify, Semaphore};
use tokio_util::sync::CancellationToken;

pub struct Job {
    pub id: String,
    pub action: String,
    pub workspace: PathBuf,
    pub started: Instant,
    /// Cancelled by codex_job_cancel, or with the server. A child of `Jobs::cancel`.
    pub cancel: CancellationToken,
    options: crate::task_options::TaskOptions,
    state: Mutex<JobState>,
    pub notify: Notify,
}
struct JobState {
    result: Option<Value>,
    status: &'static str,
    phase: &'static str,
    finished: Option<Instant>,
    last_event: Instant,
    steps: u64,
    history: Vec<Value>,
    usage: Value,
}
pub struct Jobs {
    pub config: Arc<Config>,
    entries: Mutex<HashMap<String, Arc<Job>>>,
    locks: Mutex<HashMap<PathBuf, std::sync::Weak<tokio::sync::Mutex<()>>>>,
    slots: Arc<Semaphore>,
    /// Caps Codex processes, not only jobs: one image job can start several runs.
    runs: Arc<Semaphore>,
    pub cancel: CancellationToken,
    pub artifact_slots: Arc<Semaphore>,
}

/// What `Jobs::cancel_job` did.
pub enum Cancel {
    Unknown,
    Finished(&'static str),
    Cancelled(Arc<Job>),
}

/// How long codex_job_cancel waits for the stopped job to settle.
const CANCEL_WAIT_SECS: f64 = 10.0;

impl Jobs {
    pub fn new(config: Arc<Config>) -> Arc<Self> {
        Arc::new(Self {
            slots: Arc::new(Semaphore::new(config.max_jobs)),
            runs: Arc::new(Semaphore::new(config.max_jobs)),
            config,
            entries: Mutex::new(HashMap::new()),
            locks: Mutex::new(HashMap::new()),
            cancel: CancellationToken::new(),
            artifact_slots: Arc::new(Semaphore::new(2)),
        })
    }
    pub fn start(self: &Arc<Self>, action: &str, args: Value) -> Result<Arc<Job>> {
        let prompt = args["prompt"]
            .as_str()
            .filter(|p| !p.is_empty())
            .ok_or_else(|| anyhow::anyhow!("prompt is required"))?;
        ensure!(prompt.len() <= 1_000_000, "Prompt exceeds the byte limit");
        let mut values = serde_json::to_value(&self.config.defaults)?;
        for key in [
            "model",
            "reasoning_effort",
            "timeout_sec",
            "count",
            "size",
            "quality",
            "output_format",
            "output_compression",
            "background",
            "target_file_kb",
        ] {
            if let Some(value) = args.get(key) {
                values[key] = value.clone();
            }
        }
        if args.get("model").is_none() && !self.config.model.is_empty() {
            values["model"] = json!(self.config.model);
        }
        if args.get("timeout_sec").is_none() && std::env::var_os("CODEX_TASK_DEFAULTS").is_none() {
            values["timeout_sec"] = json!(self.config.timeout.min(self.config.max_timeout));
        }
        if let Some(n) = args["timeout_sec"].as_f64() {
            values["timeout_sec"] = json!(if n > 0.0 {
                n.clamp(1.0, self.config.max_timeout.min(1800) as f64) as u64
            } else {
                self.config.defaults.timeout_sec
            });
        }
        let options: crate::task_options::TaskOptions = serde_json::from_value(values)?;
        options.validate()?;
        // The caller's own text, not the service-added image instructions, is
        // what a user can improve. Sent once; the desktop keeps merged fields.
        let mut first = if self.config.activity_prompts {
            prompt_preview(prompt)
        } else {
            json!({})
        };
        // Each requested image is its own Codex run, so several images generate
        // at once instead of one after another in a single session.
        if action == "codex_generate_image" {
            first["parallel"] = json!(options.count.min(self.config.max_jobs as u64));
        }
        let (prompt, open) = if action == "codex_generate_image" {
            (
                format!(
                    "Generate an image: {prompt}\nSize: {}.\nQuality: {}.\nOutput format: {}.\nOutput compression: {} of 100.\nBackground: {}.\nTarget file size: {} KB per image.\n{}",
                    options.size,
                    options.quality,
                    options.output_format,
                    options.output_compression,
                    options.background,
                    options.target_file_kb,
                    include_str!("../../image-instructions.txt")
                ),
                args["open"].as_bool().unwrap_or(true),
            )
        } else {
            (prompt.to_owned(), false)
        };
        let permit = self.slots.clone().try_acquire_owned().map_err(|_| {
            anyhow::anyhow!("Too many running jobs. Collect a result before starting another job")
        })?;
        let dir = workspace::prepare(&self.config.root, args["workspace"].as_str())?;
        let job = Arc::new(Job {
            id: uuid::Uuid::new_v4().to_string(),
            action: action.into(),
            workspace: dir,
            started: Instant::now(),
            cancel: self.cancel.child_token(),
            options: options.clone(),
            state: Mutex::new(JobState {
                result: None,
                status: "running",
                phase: "queued",
                finished: None,
                last_event: Instant::now(),
                steps: 0,
                history: vec![],
                usage: Value::Null,
            }),
            notify: Notify::new(),
        });
        {
            let mut entries = self.entries.lock().unwrap();
            entries.retain(|_, j| {
                j.state
                    .lock()
                    .unwrap()
                    .finished
                    .is_none_or(|t| t.elapsed() < self.config.retention)
            });
            // Results include image data. Retain a bounded history as well as a time limit.
            let mut completed: Vec<_> = entries
                .iter()
                .filter_map(|(id, j)| j.state.lock().unwrap().finished.map(|t| (t, id.clone())))
                .collect();
            completed.sort_by_key(|(t, _)| *t);
            let excess = completed.len().saturating_sub(99);
            for (_, id) in completed.into_iter().take(excess) {
                entries.remove(&id);
            }
            ensure!(entries.len() < 132, "Job storage is full");
            entries.insert(job.id.clone(), job.clone());
        }
        self.emit(&job, "running", first);
        let timeout = options.timeout_sec.min(self.config.max_timeout);
        let owner = self.clone();
        let running = job.clone();
        tokio::spawn(async move {
            let heartbeat_owner = owner.clone();
            let heartbeat_job = running.clone();
            let heartbeat = tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    heartbeat_owner.emit(&heartbeat_job, "running", json!({}));
                }
            });
            let result = owner
                .execute(&running, prompt, timeout, open)
                .await
                .unwrap_or_else(artifacts::error);
            heartbeat.abort();
            // A cancel that lands after Codex already finished cleanly changes nothing.
            let status = match (
                result["isError"].as_bool() == Some(true),
                running.cancel.is_cancelled(),
            ) {
                (true, true) => "cancelled",
                (true, false) => "failed",
                _ => "completed",
            };
            {
                let mut state = running.state.lock().unwrap();
                state.result = Some(result);
                state.status = status;
                state.finished = Some(Instant::now());
            }
            owner.emit(&running, status, json!({}));
            // Free the slot before waking waiters, so a caller that saw the job
            // finish (a cancel, say) can start the next one straight away.
            drop(permit);
            running.notify.notify_waiters();
        });
        Ok(job)
    }

    async fn execute(
        self: &Arc<Self>,
        job: &Arc<Job>,
        prompt: String,
        timeout: u64,
        open: bool,
    ) -> Result<Value> {
        let key = PathBuf::from(job.workspace.to_string_lossy().to_lowercase());
        let lock = {
            let mut locks = self.locks.lock().unwrap();
            locks.retain(|_, v| v.strong_count() > 0);
            let lock = locks
                .get(&key)
                .and_then(std::sync::Weak::upgrade)
                .unwrap_or_else(|| Arc::new(tokio::sync::Mutex::new(())));
            locks.insert(key, Arc::downgrade(&lock));
            lock
        };
        let _guard = tokio::select! {
            guard = lock.lock() => guard,
            _ = self.cancel.cancelled() => return Err(anyhow::anyhow!("Server stopped")),
            // Queued behind another run on this workspace: give up the place.
            _ = job.cancel.cancelled() => return Err(anyhow::anyhow!("Cancelled before Codex started; nothing ran and no files changed.")),
        };
        self.phase(job, "preparing");
        let dir = job.workspace.clone();
        let before = tokio::task::spawn_blocking(move || workspace::snapshot(&dir)).await?;
        self.phase(
            job,
            if job.action == "codex_generate_image" {
                "generating_image"
            } else {
                "running"
            },
        );
        let image = job.action == "codex_generate_image";
        let copies = if image { job.options.count.max(1) } else { 1 };
        let mut single = job.options.clone();
        single.count = 1;
        let run = self.run_all(job, prompt, timeout, copies, &single).await?;
        self.phase(job, "collecting_files");
        let dir = job.workspace.clone();
        let config = self.config.clone();
        let image_options = single;
        let image_threads = if image { run.threads.clone() } else { vec![] };
        let codex_home = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                    .map(|p| PathBuf::from(p).join(".codex"))
            });
        let artifact_permit = self.artifact_slots.clone().acquire_owned().await?;
        let collected = tokio::task::spawn_blocking(move || {
            let _permit = artifact_permit;
            // Collected only after every run's process tree has stopped.
            if let Some(home) = codex_home {
                for thread in &image_threads {
                    crate::generated::collect(&home, thread, &dir, &image_options)?;
                }
            }
            let after = workspace::snapshot(&dir);
            let changed: Vec<_> = after
                .iter()
                .filter(|(p, v)| before.get(*p) != Some(*v))
                .map(|(p, _)| p.clone())
                .collect();
            Ok::<_, anyhow::Error>(artifacts::collect(&config, &dir, &changed, open))
        })
        .await??;
        self.emit(
            job,
            "running",
            json!({"files":collected.count,"outputFiles":collected.details,"exitCode":run.code,"timedOut":run.timed_out}),
        );
        let missing_image = job.action == "codex_generate_image"
            && !collected.content.iter().any(|v| {
                v["type"] == "image"
                    || v["mimeType"]
                        .as_str()
                        .is_some_and(|s| s.starts_with("image/"))
            });
        let output = format!(
            "{}{}",
            run.stdout.trim(),
            if run.stderr.trim().is_empty() {
                String::new()
            } else {
                format!("\n\n[stderr]\n{}", run.stderr.trim())
            }
        );
        let summary = format!(
            "workspace: {}\nexit code: {}{}{}\nduration: {:.1}s\n\n--- codex output ---\n{}\n\n--- files created or changed ---\n{}",
            job.workspace.display(),
            run.code.map_or("n/a".into(), |c| c.to_string()),
            if run.timed_out {
                " (TIMED OUT - process killed)"
            } else {
                ""
            },
            if run.cancelled {
                " (CANCELLED - process killed)"
            } else {
                ""
            },
            run.duration as f64 / 1000.0,
            if missing_image {
                format!(
                    "{output}\nNo generated image file was available. Check the Codex image tool and saved account."
                )
            } else {
                output
            },
            if collected.lines.is_empty() {
                "(none)".into()
            } else {
                collected.lines.join("\n")
            }
        );
        let mut content = vec![artifacts::text(summary)];
        content.extend(collected.content);
        Ok(
            json!({"content":content,"isError":run.timed_out || run.cancelled || run.code != Some(0) || missing_image}),
        )
    }

    /// Runs `copies` Codex sessions of the same prompt. The job's timeout is one
    /// deadline for all of them, so a run that waits for a process slot gets
    /// only the time that remains.
    async fn run_all(
        self: &Arc<Self>,
        job: &Arc<Job>,
        prompt: String,
        timeout: u64,
        copies: u64,
        options: &crate::task_options::TaskOptions,
    ) -> Result<Combined> {
        let deadline = Instant::now() + std::time::Duration::from_secs(timeout);
        let mut set = tokio::task::JoinSet::new();
        for index in 0..copies {
            let owner = self.clone();
            let job = job.clone();
            let prompt = prompt.clone();
            let options = options.clone();
            set.spawn(async move {
                let permit = tokio::select! {
                    permit = owner.runs.clone().acquire_owned() => permit?,
                    _ = owner.cancel.cancelled() => anyhow::bail!("Server stopped"),
                    _ = job.cancel.cancelled() => anyhow::bail!("Cancelled before this run started"),
                };
                let _permit = permit;
                let left = deadline
                    .saturating_duration_since(Instant::now())
                    .as_secs_f64()
                    .ceil() as u64;
                ensure!(left > 0, "The task timed out before this run could start");
                let progress_owner = owner.clone();
                let progress_job = job.clone();
                let report = Arc::new(move |event| progress_owner.progress(&progress_job, event));
                let run = process::run(
                    &owner.config,
                    &job.workspace,
                    prompt,
                    left,
                    &options,
                    job.cancel.child_token(),
                    report,
                )
                .await?;
                Ok((index, run))
            });
        }
        let mut runs = Vec::new();
        let mut failures = Vec::new();
        while let Some(joined) = set.join_next().await {
            match joined.map_err(anyhow::Error::from).and_then(|r| r) {
                Ok(run) => runs.push(run),
                Err(e) => failures.push(e),
            }
        }
        if runs.is_empty() {
            return Err(failures
                .into_iter()
                .next()
                .unwrap_or_else(|| anyhow::anyhow!("Codex did not run")));
        }
        runs.sort_by_key(|(index, _)| *index);
        Ok(Combined::new(runs, failures))
    }
    fn progress(&self, job: &Job, event: Value) {
        if let Some(phase) = event["legacyPhase"].as_str() {
            // Retain compatibility with older CLI stderr markers.
            let phase = match phase {
                "running_command" => "running_command",
                "writing_files" => "writing_files",
                _ => "running",
            };
            self.phase(job, phase);
            return;
        }
        {
            let mut state = job.state.lock().unwrap();
            state.last_event = Instant::now();
            if event["type"] == "item.completed" {
                state.steps += 1;
            }
            if event["type"] == "turn.completed" {
                add_usage(&mut state.usage, &event["usage"]);
            }
        }
        if event["type"] == "item.started" || event["type"] == "item.updated" {
            self.phase(job, activity::phase(&event));
        } else if event["type"] == "item.completed" {
            self.phase(
                job,
                if job.action == "codex_generate_image" {
                    "generating_image"
                } else {
                    "running"
                },
            );
        }
    }
    fn phase(&self, job: &Job, phase: &'static str) {
        {
            let mut state = job.state.lock().unwrap();
            state.last_event = Instant::now();
            if state.phase != phase || state.history.is_empty() {
                if state.history.len() >= 24 {
                    state.history.remove(0);
                }
                state
                    .history
                    .push(json!({"phase":phase,"atMs":job.started.elapsed().as_millis() as u64}));
            }
            state.phase = phase;
        }
        self.emit(job, "running", json!({}));
    }
    fn emit(&self, job: &Job, status: &str, extras: Value) {
        let state = job.state.lock().unwrap();
        let mut event = json!({"type":"job","id":job.id,"action":job.action,"workspace":job.workspace,"status":status,"phase":state.phase,"elapsedMs":job.started.elapsed().as_millis() as u64,"idleMs":state.last_event.elapsed().as_millis() as u64,"steps":state.steps,"history":state.history,"options":job.options,"usage":state.usage});
        event
            .as_object_mut()
            .unwrap()
            .extend(extras.as_object().unwrap().clone());
        activity::emit(self.config.activity, event);
    }
    /// Every job still held, after dropping finished ones past retention.
    fn held(&self) -> Vec<Arc<Job>> {
        let mut entries = self.entries.lock().unwrap();
        entries.retain(|_, j| {
            j.state
                .lock()
                .unwrap()
                .finished
                .is_none_or(|t| t.elapsed() < self.config.retention)
        });
        entries.values().cloned().collect()
    }
    pub fn get(&self, id: &str) -> Option<Arc<Job>> {
        self.held().into_iter().find(|j| j.id == id)
    }
    /// Waits up to `secs` for the job to finish.
    async fn wait(job: &Job, secs: f64) {
        let notified = job.notify.notified(); // Register before checking completion.
        tokio::pin!(notified);
        notified.as_mut().enable();
        if job.state.lock().unwrap().result.is_none() {
            let _ = tokio::time::timeout(std::time::Duration::from_secs_f64(secs), notified).await;
        }
    }
    /// Stops a running job. The Codex process tree is killed, the job still
    /// collects and reports its files, and its slot frees once it settles.
    pub fn cancel_job(&self, id: &str) -> Cancel {
        let Some(job) = self.get(id) else {
            return Cancel::Unknown;
        };
        let status = job.state.lock().unwrap().status;
        if status != "running" {
            return Cancel::Finished(status);
        }
        job.cancel.cancel();
        Cancel::Cancelled(job)
    }
    pub async fn cancel_result(&self, id: &str) -> Value {
        match self.cancel_job(id) {
            Cancel::Unknown => artifacts::error(format!(
                "Unknown job \"{id}\". It may have expired, or the server restarted."
            )),
            Cancel::Finished(status) => json!({"content":[artifacts::text(format!(
                "status: {status}\njob_id: {id}\n\nThe job already finished, so there was nothing to cancel. Call codex_job_result with this job_id to collect its result."
            ))]}),
            Cancel::Cancelled(job) => {
                // Give the kill a moment to land so the caller usually sees the
                // final state, but never hold the call near the client timeout.
                Self::wait(&job, CANCEL_WAIT_SECS).await;
                let status = job.state.lock().unwrap().status;
                let (shown, said) = if status == "running" {
                    (
                        "cancelling",
                        "Cancellation was requested and the Codex process is being stopped. ",
                    )
                } else {
                    (status, "The job was stopped. ")
                };
                json!({"content":[artifacts::text(format!(
                    "status: {shown}\njob_id: {}\nworkspace: {}\n\n{said}Call codex_job_result with this job_id for its output and any files it wrote.",
                    job.id,
                    job.workspace.display()
                ))]})
            }
        }
    }
    /// One line per held job, newest first. Never includes prompt text.
    pub fn list(&self, filter: &str) -> Value {
        let mut jobs = self.held();
        jobs.sort_by_key(|j| std::cmp::Reverse(j.started));
        let lines: Vec<String> = jobs
            .iter()
            .filter_map(|job| {
                let state = job.state.lock().unwrap();
                let running = state.status == "running";
                if (filter == "running" && !running) || (filter == "finished" && running) {
                    return None;
                }
                let elapsed = state
                    .finished
                    .map_or(job.started.elapsed(), |t| t.duration_since(job.started));
                Some(format!(
                    "job_id: {} | tool: {} | status: {} | phase: {} | elapsed: {}s | workspace: {}",
                    job.id,
                    job.action,
                    state.status,
                    state.phase,
                    elapsed.as_secs_f64().round() as u64,
                    job.workspace.display()
                ))
            })
            .collect();
        let text = if lines.is_empty() {
            match filter {
                "running" | "finished" => format!("No {filter} jobs."),
                _ => "No jobs.".into(),
            }
        } else {
            lines.join("\n")
        };
        json!({"content":[artifacts::text(text)]})
    }
    pub async fn result(&self, job: Arc<Job>, wait: Option<f64>) -> Value {
        let wait = wait
            .filter(|n| n.is_finite())
            .unwrap_or(self.config.wait as f64)
            .clamp(0.0, 50.0);
        Self::wait(&job, wait).await;
        job.state.lock().unwrap().result.clone().unwrap_or_else(|| json!({"content":[artifacts::text(format!("status: running\njob_id: {}\nworkspace: {}\nelapsed: {}s\n\nCodex is still working. Call codex_job_result with this job_id to collect the result.", job.id, job.workspace.display(), job.started.elapsed().as_secs()))]}))
    }
}

/// Parallel runs each report their own token usage; the job shows the total.
fn add_usage(total: &mut Value, usage: &Value) {
    let Some(usage) = usage.as_object() else {
        return;
    };
    if !total.is_object() {
        *total = json!({});
    }
    for (key, value) in usage {
        if let Some(n) = value.as_u64() {
            total[key] = json!(total[key].as_u64().unwrap_or(0) + n);
        }
    }
}

/// The outcome of one or more runs of the same job, reported as one result.
struct Combined {
    stdout: String,
    stderr: String,
    code: Option<i32>,
    timed_out: bool,
    cancelled: bool,
    duration: u128,
    threads: Vec<String>,
}
impl Combined {
    fn new(runs: Vec<(u64, process::Output)>, failures: Vec<anyhow::Error>) -> Self {
        let many = runs.len() + failures.len() > 1;
        let label = |index: u64, text: &str| {
            if many {
                format!("[run {}]\n{}", index + 1, text.trim())
            } else {
                text.trim().to_owned()
            }
        };
        let stderr: Vec<_> = runs
            .iter()
            .filter(|(_, r)| !r.stderr.trim().is_empty())
            .map(|(i, r)| label(*i, &r.stderr))
            .chain(
                failures
                    .iter()
                    .map(|e| format!("A parallel run did not finish: {e}")),
            )
            .collect();
        Self {
            stdout: runs
                .iter()
                .map(|(i, r)| label(*i, &r.stdout))
                .collect::<Vec<_>>()
                .join("\n\n"),
            stderr: stderr.join("\n\n"),
            // Any failed run fails the job; its exit code is the one reported.
            code: if failures.is_empty() {
                runs.iter()
                    .map(|(_, r)| r.code)
                    .find(|c| *c != Some(0))
                    .unwrap_or(Some(0))
            } else {
                None
            },
            timed_out: runs.iter().any(|(_, r)| r.timed_out),
            cancelled: runs.iter().any(|(_, r)| r.cancelled),
            duration: runs.iter().map(|(_, r)| r.duration).max().unwrap_or(0),
            threads: runs.into_iter().filter_map(|(_, r)| r.thread).collect(),
        }
    }
}

/// The desktop drops activity lines over 16 KiB, so the prompt is bounded by
/// characters and by its escaped JSON size, which can be six times larger.
const PROMPT_PREVIEW_CHARS: usize = 2000;
const PROMPT_PREVIEW_JSON: usize = 8000;
fn prompt_preview(prompt: &str) -> Value {
    let mut text: String = prompt.chars().take(PROMPT_PREVIEW_CHARS).collect();
    while serde_json::to_string(&text).map_or(0, |s| s.len()) > PROMPT_PREVIEW_JSON {
        let keep = text.chars().count() * 3 / 4;
        text = text.chars().take(keep).collect();
    }
    let total = prompt.chars().count();
    json!({"prompt":text,"promptChars":total,"promptTruncated":text.chars().count() < total})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(code: Option<i32>, thread: &str) -> process::Output {
        process::Output {
            stdout: format!("done {thread}"),
            stderr: String::new(),
            code,
            timed_out: false,
            cancelled: false,
            duration: 10,
            thread: Some(thread.into()),
        }
    }

    #[test]
    fn parallel_runs_combine_into_one_result() {
        let single = Combined::new(vec![(0, output(Some(0), "a"))], vec![]);
        assert_eq!(single.stdout, "done a");
        assert_eq!(single.code, Some(0));
        // run_all sorts runs by index before combining them.
        let all = Combined::new(
            vec![(0, output(Some(0), "a")), (1, output(Some(0), "b"))],
            vec![],
        );
        assert_eq!(all.code, Some(0));
        assert_eq!(all.threads, ["a", "b"]);
        assert_eq!(all.stdout, "[run 1]\ndone a\n\n[run 2]\ndone b");
        let failed = Combined::new(
            vec![(0, output(Some(0), "a")), (1, output(Some(7), "b"))],
            vec![],
        );
        assert_eq!(failed.code, Some(7));
        let missing = Combined::new(
            vec![(0, output(Some(0), "a"))],
            vec![anyhow::anyhow!("timed out before start")],
        );
        assert_eq!(missing.code, None);
        assert!(
            missing
                .stderr
                .contains("did not finish: timed out before start")
        );
        assert_eq!(missing.threads, ["a"]);
    }

    #[test]
    fn usage_adds_up_across_runs() {
        let mut total = Value::Null;
        add_usage(&mut total, &json!({"input_tokens":100,"output_tokens":20}));
        add_usage(
            &mut total,
            &json!({"input_tokens":50,"output_tokens":5,"cached_input_tokens":7}),
        );
        add_usage(&mut total, &Value::Null);
        assert_eq!(
            total,
            json!({"input_tokens":150,"output_tokens":25,"cached_input_tokens":7})
        );
    }

    #[test]
    fn prompt_preview_is_bounded() {
        let short = prompt_preview("Draw a red fox");
        assert_eq!(short["prompt"], "Draw a red fox");
        assert_eq!(short["promptTruncated"], false);
        let long = prompt_preview(&"é".repeat(5000));
        assert_eq!(
            long["prompt"].as_str().unwrap().chars().count(),
            PROMPT_PREVIEW_CHARS
        );
        assert_eq!(long["promptChars"], 5000);
        assert_eq!(long["promptTruncated"], true);
        let control = prompt_preview(&"\u{1}".repeat(5000));
        assert!(serde_json::to_string(&control["prompt"]).unwrap().len() <= PROMPT_PREVIEW_JSON);
        assert_eq!(control["promptTruncated"], true);
    }

    fn fixture_config(root: &std::path::Path) -> Config {
        // cargo builds the examples alongside the test binaries (target/<profile>/deps).
        let exe = std::env::current_exe().unwrap();
        let bin = exe.parent().unwrap().parent().unwrap().join(format!(
            "examples/fake_codex{}",
            std::env::consts::EXE_SUFFIX
        ));
        assert!(bin.is_file(), "build the fake_codex example first: {bin:?}");
        Config {
            root: root.canonicalize().unwrap(),
            bin,
            model: String::new(),
            mode: "workspace-write".into(),
            backend: String::new(),
            network: false,
            runtime: String::new(),
            private: String::new(),
            timeout: 120,
            max_timeout: 1800,
            output: 40_000,
            wait: 0,
            max_jobs: 1,
            retention: std::time::Duration::from_secs(3600),
            inline: 350_000,
            response: 750_000,
            files: 200,
            activity: false,
            activity_prompts: false,
            defaults: Default::default(),
        }
    }

    /// True while the process exists. A Linux zombie has already exited.
    fn alive(pid: u32) -> bool {
        if cfg!(windows) {
            let out = std::process::Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/NH"])
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
        } else if cfg!(target_os = "linux") {
            std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|s| {
                s.rsplit_once(") ")
                    .is_some_and(|(_, r)| !r.starts_with('Z'))
            })
        } else {
            false
        }
    }

    fn text(result: &Value) -> String {
        result["content"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|c| c["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }

    async fn eventually(mut check: impl FnMut() -> bool) -> bool {
        for _ in 0..150 {
            if check() {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        check()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancel_kills_the_tree_reports_files_and_frees_the_slot() {
        let root = tempfile::tempdir().unwrap();
        let jobs = Jobs::new(Arc::new(fixture_config(root.path())));
        let job = jobs
            .start(
                "codex_run",
                json!({"prompt":"private-prompt-sentinel FAKE_SLEEP","workspace":"cancel-me"}),
            )
            .unwrap();
        let pids_file = job.workspace.join("pids.txt");
        assert!(
            eventually(|| std::fs::read_to_string(&pids_file).is_ok_and(|s| s.contains(' '))).await
        );
        let pids: Vec<u32> = std::fs::read_to_string(&pids_file)
            .unwrap()
            .split(' ')
            .map(|p| p.trim().parse().unwrap())
            .collect();
        assert!(pids.iter().all(|p| alive(*p)));

        // The single slot is taken while the job runs.
        assert!(jobs.start("codex_run", json!({"prompt":"quick"})).is_err());
        let running = text(&jobs.list("running"));
        assert!(running.contains(&format!(
            "job_id: {} | tool: codex_run | status: running",
            job.id
        )));
        assert!(!running.contains("private-prompt-sentinel"));

        let cancelled = jobs.cancel_result(&job.id).await;
        assert_ne!(cancelled["isError"], true);
        assert!(
            text(&cancelled).contains("status: cancelled"),
            "{cancelled}"
        );
        assert!(eventually(|| !pids.iter().any(|p| alive(*p))).await);

        let result = jobs.result(job.clone(), Some(0.0)).await;
        assert_eq!(result["isError"], true);
        assert!(text(&result).contains("(CANCELLED - process killed)"));
        assert!(text(&result).contains("partial.txt"));
        assert!(job.workspace.join("partial.txt").is_file());

        // The slot is free again, and a finished job has nothing to cancel.
        let next = jobs
            .start("codex_run", json!({"prompt":"quick","workspace":"next"}))
            .unwrap();
        assert_eq!(
            jobs.result(next.clone(), Some(20.0)).await["isError"],
            false
        );
        let finished = jobs.cancel_result(&next.id).await;
        assert_ne!(finished["isError"], true);
        assert!(text(&finished).contains("status: completed"));
        assert!(text(&finished).contains("already finished"));

        let all = text(&jobs.list("all"));
        let lines: Vec<_> = all.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with(&format!(
            "job_id: {} | tool: codex_run | status: completed",
            next.id
        )));
        assert!(lines[1].starts_with(&format!(
            "job_id: {} | tool: codex_run | status: cancelled",
            job.id
        )));
        assert!(
            lines[0].contains(" | elapsed: ")
                && lines[0].ends_with(&format!("workspace: {}", next.workspace.display()))
        );
        assert_eq!(text(&jobs.list("running")), "No running jobs.");
        assert_eq!(text(&jobs.list("finished")).lines().count(), 2);

        let unknown = jobs.cancel_result("no-such-job").await;
        assert_eq!(unknown["isError"], true);
        assert!(text(&unknown).contains("Unknown job \"no-such-job\""));
    }

    #[test]
    fn image_sizes() {
        for v in ["auto", "1024x1024", "800x600"] {
            assert!(crate::task_options::validate_size(v).is_ok());
        }
        for v in ["0x1", "16385x1", "1x2x3", "NaN", "-1x1"] {
            assert!(crate::task_options::validate_size(v).is_err());
        }
    }
}
