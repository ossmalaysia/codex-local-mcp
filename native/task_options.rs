use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

/// Persisted defaults and an allowlist for per-request overrides. No raw CLI options.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TaskOptions {
    pub model: String,
    pub reasoning_effort: String,
    pub timeout_sec: u64,
    pub count: u64,
    pub size: String,
    pub quality: String,
    pub output_format: String,
    pub output_compression: u8,
    pub background: String,
    pub target_file_kb: u64,
}
impl Default for TaskOptions {
    fn default() -> Self {
        Self {
            model: String::new(),
            reasoning_effort: "default".into(),
            timeout_sec: 300,
            count: 1,
            size: "1024x1024".into(),
            quality: "low".into(),
            output_format: "jpeg".into(),
            output_compression: 80,
            background: "opaque".into(),
            target_file_kb: 256,
        }
    }
}
impl TaskOptions {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.model.len() <= 128
                && self
                    .model
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._:/-".contains(&b)),
            "Invalid model name"
        );
        ensure!(
            [
                "default", "none", "minimal", "low", "medium", "high", "xhigh"
            ]
            .contains(&self.reasoning_effort.as_str()),
            "Invalid reasoning effort"
        );
        ensure!(
            (1..=1800).contains(&self.timeout_sec),
            "Timeout must be between 1 and 1800 seconds"
        );
        ensure!(
            (1..=10).contains(&self.count),
            "Image count must be between 1 and 10"
        );
        validate_size(&self.size)?;
        ensure!(
            ["low", "medium", "high", "auto"].contains(&self.quality.as_str()),
            "Invalid image quality"
        );
        ensure!(
            ["png", "jpeg", "webp"].contains(&self.output_format.as_str()),
            "Invalid output format"
        );
        ensure!(
            (1..=100).contains(&self.output_compression),
            "Output compression must be between 1 and 100"
        );
        ensure!(
            ["opaque", "transparent", "auto"].contains(&self.background.as_str()),
            "Invalid background"
        );
        ensure!(
            self.output_format != "jpeg" || self.background != "transparent",
            "Use PNG or WebP for a transparent background"
        );
        ensure!(
            (16..=10240).contains(&self.target_file_kb),
            "Target file size must be between 16 and 10240 KB"
        );
        Ok(())
    }
}
pub fn validate_size(size: &str) -> Result<()> {
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
    fn rejects_cli_injection_and_incompatible_image_options() {
        let options = TaskOptions {
            reasoning_effort: "low -c approval=always".into(),
            ..Default::default()
        };
        assert!(options.validate().is_err());
        let options = TaskOptions {
            background: "transparent".into(),
            ..Default::default()
        };
        assert!(options.validate().is_err());
        assert!(TaskOptions::default().validate().is_ok());
    }
}
