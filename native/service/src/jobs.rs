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
    state: Mutex<JobState>,
    pub notify: Notify,
}
struct JobState {
    result: Option<Value>,
    phase: &'static str,
    finished: Option<Instant>,
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
        let model = args["model"].as_str().unwrap_or(&self.config.model);
        ensure!(
            model.len() <= 128
                && model
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._:/-".contains(&b)),
            "Invalid model name"
        );
        let (prompt, open) = if action == "codex_generate_image" {
            let count = args.get("count").and_then(Value::as_u64).unwrap_or(1);
            ensure!((1..=10).contains(&count), "count must be between 1 and 10");
            let size = args["size"].as_str().unwrap_or("1024x1024");
            validate_size(size)?;
            let quality = args["quality"].as_str().unwrap_or("low");
            ensure!(
                ["low", "medium", "high", "auto"].contains(&quality),
                "Invalid image quality"
            );
            (
                format!(
                    "{}: {prompt}\nSize: {size}.\nQuality: {quality}.\nSave the image file(s) into ./output/ in the current directory.",
                    if count > 1 {
                        format!("Generate {count} images")
                    } else {
                        "Generate an image".into()
                    }
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
            state: Mutex::new(JobState {
                result: None,
                phase: "queued",
                finished: None,
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
        self.emit(&job, "running", json!({}));
        let timeout = args["timeout_sec"]
            .as_f64()
            .filter(|n| n.is_finite() && *n > 0.0)
            .unwrap_or(self.config.timeout as f64)
            .clamp(1.0, self.config.max_timeout as f64) as u64;
        let model = model.to_owned();
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
                .execute(&running, prompt, timeout, model, open)
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
        model: String,
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
        self.phase(job, "running");
        let owner = self.clone();
        let progress_job = job.clone();
        let report = Arc::new(move |phase| owner.phase(&progress_job, phase));
        let run = process::run(
            &self.config,
            &job.workspace,
            prompt,
            timeout,
            &model,
            self.cancel.child_token(),
            report,
        )
        .await?;
        self.phase(job, "collecting_files");
        let dir = job.workspace.clone();
        let config = self.config.clone();
        let artifact_permit = self.artifact_slots.clone().acquire_owned().await?;
        let collected = tokio::task::spawn_blocking(move || {
            let _permit = artifact_permit;
            let after = workspace::snapshot(&dir);
            let changed: Vec<_> = after
                .iter()
                .filter(|(p, v)| before.get(*p) != Some(*v))
                .map(|(p, _)| p.clone())
                .collect();
            artifacts::collect(&config, &dir, &changed, open)
        })
        .await?;
        self.emit(
            job,
            "running",
            json!({"files":collected.count,"exitCode":run.code,"timedOut":run.timed_out}),
        );
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
            output,
            if collected.lines.is_empty() {
                "(none)".into()
            } else {
                collected.lines.join("\n")
            }
        );
        let mut content = vec![artifacts::text(summary)];
        content.extend(collected.content);
        Ok(json!({"content":content,"isError":run.timed_out || run.code != Some(0)}))
    }

    fn phase(&self, job: &Job, phase: &'static str) {
        job.state.lock().unwrap().phase = phase;
        self.emit(job, "running", json!({}));
    }
    fn emit(&self, job: &Job, status: &str, extras: Value) {
        let mut event = json!({"type":"job","id":job.id,"action":job.action,"workspace":job.workspace,"status":status,"phase":job.state.lock().unwrap().phase,"elapsedMs":job.started.elapsed().as_millis() as u64});
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

fn validate_size(size: &str) -> Result<()> {
    let size = size.trim().to_lowercase();
    if size == "auto" {
        return Ok(());
    }
    let Some((w, h)) = size.split_once('x') else {
        anyhow::bail!("Use WIDTHxHEIGHT or auto");
    };
    ensure!(
        !w.is_empty()
            && !h.is_empty()
            && w.len() <= 5
            && h.len() <= 5
            && w.bytes().chain(h.bytes()).all(|b| b.is_ascii_digit()),
        "Invalid image size"
    );
    let w: u32 = w.parse()?;
    let h: u32 = h.parse()?;
    ensure!(
        (1..=16384).contains(&w) && (1..=16384).contains(&h),
        "Image dimensions must be between 1 and 16384"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_sizes() {
        for v in ["auto", "1024x1024", "800x600"] {
            assert!(validate_size(v).is_ok());
        }
        for v in ["0x1", "16385x1", "1x2x3", "NaN", "-1x1"] {
            assert!(validate_size(v).is_err());
        }
    }
}
