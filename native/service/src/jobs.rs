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
    options: crate::task_options::TaskOptions,
    state: Mutex<JobState>,
    pub notify: Notify,
}
struct JobState {
    result: Option<Value>,
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
    pub cancel: CancellationToken,
    pub artifact_slots: Arc<Semaphore>,
}

impl Jobs {
    pub fn new(config: Arc<Config>) -> Arc<Self> {
        Arc::new(Self {
            slots: Arc::new(Semaphore::new(config.max_jobs)),
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
        let first = if self.config.activity_prompts {
            prompt_preview(prompt)
        } else {
            json!({})
        };
        let (prompt, open) = if action == "codex_generate_image" {
            (
                format!(
                    "{}: {prompt}\nSize: {}.\nQuality: {}.\nOutput format: {}.\nOutput compression: {} of 100.\nBackground: {}.\nTarget file size: {} KB per image.\n{}",
                    if options.count > 1 {
                        format!("Generate {} images", options.count)
                    } else {
                        "Generate an image".into()
                    },
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
            options: options.clone(),
            state: Mutex::new(JobState {
                result: None,
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
            let _permit = permit;
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
            let status = if result["isError"].as_bool() == Some(true) {
                "failed"
            } else {
                "completed"
            };
            {
                let mut state = running.state.lock().unwrap();
                state.result = Some(result);
                state.finished = Some(Instant::now());
            }
            owner.emit(&running, status, json!({}));
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
        let _guard = tokio::select! { guard = lock.lock() => guard, _ = self.cancel.cancelled() => return Err(anyhow::anyhow!("Server stopped")) };
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
        let owner = self.clone();
        let progress_job = job.clone();
        let report = Arc::new(move |event| owner.progress(&progress_job, event));
        let run = process::run(
            &self.config,
            &job.workspace,
            prompt,
            timeout,
            &job.options,
            self.cancel.child_token(),
            report,
        )
        .await?;
        self.phase(job, "collecting_files");
        let dir = job.workspace.clone();
        let config = self.config.clone();
        let image_options = job.options.clone();
        let image_thread = if job.action == "codex_generate_image" {
            run.thread.clone()
        } else {
            None
        };
        let codex_home = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                    .map(|p| PathBuf::from(p).join(".codex"))
            });
        let artifact_permit = self.artifact_slots.clone().acquire_owned().await?;
        let collected = tokio::task::spawn_blocking(move || {
            let _permit = artifact_permit;
            if let (Some(home), Some(thread)) = (codex_home, image_thread) {
                crate::generated::collect(&home, &thread, &dir, &image_options)?;
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
            "workspace: {}\nexit code: {}{}\nduration: {:.1}s\n\n--- codex output ---\n{}\n\n--- files created or changed ---\n{}",
            job.workspace.display(),
            run.code.map_or("n/a".into(), |c| c.to_string()),
            if run.timed_out {
                " (TIMED OUT - process killed)"
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
            json!({"content":content,"isError":run.timed_out || run.code != Some(0) || missing_image}),
        )
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
                state.usage = event["usage"].clone();
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
    pub fn get(&self, id: &str) -> Option<Arc<Job>> {
        let mut entries = self.entries.lock().unwrap();
        entries.retain(|_, j| {
            j.state
                .lock()
                .unwrap()
                .finished
                .is_none_or(|t| t.elapsed() < self.config.retention)
        });
        entries.get(id).cloned()
    }
    pub async fn result(&self, job: Arc<Job>, wait: Option<f64>) -> Value {
        let wait = wait
            .filter(|n| n.is_finite())
            .unwrap_or(self.config.wait as f64)
            .clamp(0.0, 50.0);
        let notified = job.notify.notified(); // Register before checking completion.
        tokio::pin!(notified);
        notified.as_mut().enable();
        if job.state.lock().unwrap().result.is_none() {
            let _ = tokio::time::timeout(std::time::Duration::from_secs_f64(wait), notified).await;
        }
        job.state.lock().unwrap().result.clone().unwrap_or_else(|| json!({"content":[artifacts::text(format!("status: running\njob_id: {}\nworkspace: {}\nelapsed: {}s\n\nCodex is still working. Call codex_job_result with this job_id to collect the result.", job.id, job.workspace.display(), job.started.elapsed().as_secs()))]}))
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
