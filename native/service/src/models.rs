//! Model allowlist and the `codex_models` report. Mirrors src/models.ts: the
//! two services must accept the same models and print the same lines.
use crate::config::Config;
use anyhow::{Result, bail};

/// Every value the reasoning_effort parameter accepts, in schema order.
pub const REASONING_EFFORTS: [&str; 7] = [
    "default", "none", "minimal", "low", "medium", "high", "xhigh",
];

/// Model ids reach the Codex command line, so only characters real ids use.
fn safe(model: &str) -> bool {
    (1..=128).contains(&model.len())
        && model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:/-".contains(&b))
}

/// Parse CODEX_ALLOWED_MODELS. Empty means no restriction.
pub fn parse_allowed(raw: &str) -> Result<Vec<String>> {
    let mut allowed = Vec::new();
    for model in raw.split(',').map(str::trim).filter(|m| !m.is_empty()) {
        if !safe(model) {
            bail!(
                "CODEX_ALLOWED_MODELS contains \"{model}\": model ids may only use letters, digits and . _ : / -."
            );
        }
        allowed.push(model.to_owned());
    }
    Ok(allowed)
}

/// The model a task uses when the caller does not choose one.
pub fn default_model(model: &str, defaults: &crate::task_options::TaskOptions) -> String {
    if model.is_empty() {
        defaults.model.clone()
    } else {
        model.to_owned()
    }
}

/// Checked at startup, so a default outside the allowlist stops the service
/// instead of failing every task that does not choose a model.
pub fn check_default(allowed: &[String], default: &str) -> Result<()> {
    if !allowed.is_empty() && !default.is_empty() && !allowed.iter().any(|m| m == default) {
        bail!(
            "CODEX_MODEL \"{default}\" is not in CODEX_ALLOWED_MODELS ({}). Add it to the list or change CODEX_MODEL.",
            allowed.join(", ")
        );
    }
    Ok(())
}

/// The one place a task's model is checked. Called before a job starts, so a
/// refused model never becomes a Codex process. Empty means the Codex default.
pub fn validate(allowed: &[String], model: &str) -> Result<()> {
    if model.is_empty() {
        return Ok(());
    }
    if !safe(model) {
        bail!(
            "Refusing to pass model \"{model}\": only letters, digits and . _ : / - are allowed."
        );
    }
    if !allowed.is_empty() && !allowed.iter().any(|m| m == model) {
        bail!(
            "Model \"{model}\" is not allowed. Allowed models: {}. Call codex_models to see allowed values.",
            allowed.join(", ")
        );
    }
    Ok(())
}

/// The text codex_models returns. The TypeScript service writes the same lines.
pub fn report(config: &Config) -> String {
    let allowed = if config.allowed_models.is_empty() {
        "any (no allowlist set)".to_owned()
    } else {
        config.allowed_models.join(", ")
    };
    let default = default_model(&config.model, &config.defaults);
    [
        format!("allowed_models: {allowed}"),
        format!(
            "default_model: {}",
            if default.is_empty() {
                "Codex CLI default"
            } else {
                &default
            }
        ),
        format!("reasoning_efforts: {}", REASONING_EFFORTS.join(", ")),
        format!(
            "default_reasoning_effort: {}",
            config.defaults.reasoning_effort
        ),
        String::new(),
        "Pass model and reasoning_effort on codex_run or codex_generate_image to choose them per task."
            .to_owned(),
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_trims_and_refuses_unsafe_entries() {
        assert!(parse_allowed("").unwrap().is_empty());
        assert_eq!(
            parse_allowed(" gpt-5-codex , gpt-5 ,").unwrap(),
            ["gpt-5-codex", "gpt-5"]
        );
        let error = parse_allowed("gpt-5,bad model").unwrap_err().to_string();
        assert!(error.contains("CODEX_ALLOWED_MODELS contains \"bad model\""));
    }

    #[test]
    fn default_must_be_listed() {
        let allowed = vec!["gpt-5".to_owned()];
        assert!(check_default(&allowed, "gpt-5").is_ok());
        assert!(check_default(&allowed, "").is_ok());
        assert!(check_default(&[], "o3").is_ok());
        let error = check_default(&allowed, "o3").unwrap_err().to_string();
        assert!(error.contains("CODEX_MODEL \"o3\" is not in CODEX_ALLOWED_MODELS (gpt-5)"));
    }

    #[test]
    fn validates_requested_models() {
        let allowed = vec!["gpt-5-codex".to_owned(), "gpt-5".to_owned()];
        assert!(validate(&allowed, "gpt-5").is_ok());
        assert!(validate(&allowed, "").is_ok());
        assert!(validate(&[], "anything").is_ok());
        assert!(validate(&[], "bad model").is_err());
        let error = validate(&allowed, "gpt-4o").unwrap_err().to_string();
        assert_eq!(
            error,
            "Model \"gpt-4o\" is not allowed. Allowed models: gpt-5-codex, gpt-5. Call codex_models to see allowed values."
        );
    }

    #[test]
    fn report_matches_the_typescript_service() {
        let mut config = Config::for_tests(std::path::Path::new("."));
        assert_eq!(
            report(&config),
            "allowed_models: any (no allowlist set)\ndefault_model: Codex CLI default\n\
             reasoning_efforts: default, none, minimal, low, medium, high, xhigh\n\
             default_reasoning_effort: default\n\n\
             Pass model and reasoning_effort on codex_run or codex_generate_image to choose them per task."
        );
        config.allowed_models = vec!["gpt-5-codex".into(), "gpt-5".into()];
        config.defaults.model = "gpt-5-codex".into();
        config.defaults.reasoning_effort = "high".into();
        let text = report(&config);
        assert!(text.contains("allowed_models: gpt-5-codex, gpt-5\n"));
        assert!(text.contains("default_model: gpt-5-codex\n"));
        assert!(text.contains("default_reasoning_effort: high\n"));
        config.model = "gpt-5".into();
        assert!(report(&config).contains("default_model: gpt-5\n"));
    }
}
