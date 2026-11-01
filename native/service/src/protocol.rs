use crate::{activity, artifacts, jobs::Jobs};
use rmcp::{
    ErrorData, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ListResourceTemplatesResult,
        ListResourcesResult, ListToolsResult, PaginatedRequestParams, ReadResourceRequestParams,
        ReadResourceResponse, ReadResourceResult, ServerConfig,
    },
    service::RequestContext,
};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc};

#[derive(Clone)]
pub struct Protocol {
    pub jobs: Arc<Jobs>,
}
fn convert<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, ErrorData> {
    serde_json::from_value(value)
        .map_err(|_| ErrorData::internal_error("Native protocol conversion failed", None))
}

fn validate(name: &str, args: &Value) -> anyhow::Result<()> {
    let contract: Value = serde_json::from_str(include_str!("../contract.json"))?;
    let schema = &contract["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == name)
        .unwrap()["inputSchema"];
    for key in schema["required"].as_array().into_iter().flatten() {
        anyhow::ensure!(
            args.get(key.as_str().unwrap()).is_some(),
            "{} is required",
            key.as_str().unwrap()
        );
    }
    for (key, rule) in schema["properties"].as_object().unwrap() {
        let Some(value) = args.get(key) else {
            continue;
        };
        let valid = match rule["type"].as_str().unwrap_or("") {
            "string" => value.as_str().is_some_and(|s| {
                s.chars().count() >= rule["minLength"].as_u64().unwrap_or(0) as usize
            }),
            "number" => value.is_number(),
            "integer" => value.as_f64().is_some_and(|n| n.fract() == 0.0),
            "boolean" => value.is_boolean(),
            _ => false,
        };
        anyhow::ensure!(valid, "Invalid type or value for {key}");
        if let Some(choices) = rule["enum"].as_array() {
            anyhow::ensure!(choices.contains(value), "Invalid value for {key}");
        }
        if let Some(number) = value.as_f64() {
            anyhow::ensure!(
                rule["minimum"].as_f64().is_none_or(|n| number >= n)
                    && rule["maximum"].as_f64().is_none_or(|n| number <= n),
                "Value outside limits for {key}"
            );
        }
    }
    Ok(())
}
impl ServerHandler for Protocol {
    fn get_info(&self) -> ServerConfig {
        serde_json::from_value(json!({"protocolVersion":"2025-03-26", "capabilities":{"tools":{},"resources":{}},"serverInfo":{"name":"codex-local-mcp","version":option_env!("CODEX_MCP_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))}})).unwrap()
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        activity::emit(
            self.jobs.config.activity,
            json!({"type":"request","action":"tools/list"}),
        );
        let contract: Value = serde_json::from_str(include_str!("../contract.json")).unwrap();
        convert(json!({"tools":contract["tools"]}))
    }
    async fn list_resources(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        activity::emit(
            self.jobs.config.activity,
            json!({"type":"request","action":"resources/list"}),
        );
        convert(json!({"resources":[]}))
    }
    async fn list_resource_templates(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, ErrorData> {
        let contract: Value = serde_json::from_str(include_str!("../contract.json")).unwrap();
        convert(json!({"resourceTemplates":contract["resourceTemplates"]}))
    }
    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        activity::emit(
            self.jobs.config.activity,
            json!({"type":"request","action":"resources/read"}),
        );
        let config = self.jobs.config.clone();
        let permit = self
            .jobs
            .artifact_slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| ErrorData::internal_error("Artifact worker unavailable", None))?;
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            artifacts::resource(&config, &request.uri)
        })
        .await
        .map_err(|_| ErrorData::internal_error("Artifact worker failed", None))?
        .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
        Ok(convert::<ReadResourceResult>(result)?.into())
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let name = request.name.as_ref();
        if ![
            "codex_run",
            "codex_generate_image",
            "codex_job_result",
            "codex_read_artifact",
        ]
        .contains(&name)
        {
            return Err(ErrorData::invalid_params("Unknown tool", None));
        }
        activity::emit(
            self.jobs.config.activity,
            json!({"type":"request","action":name}),
        );
        let args = Value::Object(request.arguments.unwrap_or_default());
        if let Err(error) = validate(name, &args) {
            return Ok(convert::<CallToolResult>(artifacts::error(error))?.into());
        }
        let wait = args["wait_sec"].as_f64();
        let result = match name {
            "codex_run" | "codex_generate_image" => match self.jobs.start(name, args) {
                Ok(job) => self.jobs.result(job, wait).await,
                Err(e) => artifacts::error(e),
            },
            "codex_job_result" => match self.jobs.get(args["job_id"].as_str().unwrap_or("")) {
                Some(job) => self.jobs.result(job, wait).await,
                None => artifacts::error(
                    "Unknown job. It may have expired, or the server restarted. Files remain in the workspace",
                ),
            },
            "codex_read_artifact" => {
                if args
                    .get("max_bytes")
                    .is_some_and(|v| v.as_f64().is_none_or(|n| n < 0.0))
                {
                    return Ok(convert::<CallToolResult>(artifacts::error(
                        "max_bytes must be nonnegative",
                    ))?
                    .into());
                }
                let config = self.jobs.config.clone();
                let path = args["path"].as_str().unwrap_or("").to_owned();
                let max = args["max_bytes"]
                    .as_u64()
                    .unwrap_or(5_000_000)
                    .min(50_000_000) as usize;
                let permit = self
                    .jobs
                    .artifact_slots
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|_| ErrorData::internal_error("Artifact worker unavailable", None))?;
                match tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    artifacts::read_tool(&config, Path::new(&path), max)
                })
                .await
                {
                    Ok(Ok(value)) => value,
                    Ok(Err(e)) => artifacts::error(e),
                    Err(_) => artifacts::error("Artifact worker failed"),
                }
            }
            _ => unreachable!(),
        };
        Ok(convert::<CallToolResult>(result)?.into())
    }
}
