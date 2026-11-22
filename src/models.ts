import { config } from "./config.js";

/**
 * Values that reach a Windows command line must not be able to smuggle in
 * environment expansion or quoting tricks. Model names are the only free-form
 * argument we pass, so they are restricted to characters real model ids use.
 */
export const SAFE_MODEL = /^[A-Za-z0-9._:/-]{1,128}$/;

/** Every value the reasoning_effort parameter accepts, in schema order. */
export const REASONING_EFFORTS = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export class UnsafeArgumentError extends Error {
  constructor(value: string) {
    super(
      `Refusing to pass model "${value}": only letters, digits and . _ : / - are allowed.`,
    );
  }
}

/**
 * Check CODEX_ALLOWED_MODELS against itself and against CODEX_MODEL. Called at
 * startup so a misconfigured allowlist stops the server instead of failing
 * every task later. An empty allowlist means no restriction.
 */
export function assertModelConfig(
  allowed: readonly string[] = config.allowedModels,
  defaultModel: string = config.model,
): void {
  for (const model of allowed) {
    if (!SAFE_MODEL.test(model)) {
      throw new Error(
        `CODEX_ALLOWED_MODELS contains "${model}": model ids may only use letters, digits and . _ : / -.`,
      );
    }
  }
  if (allowed.length && defaultModel && !allowed.includes(defaultModel)) {
    throw new Error(
      `CODEX_MODEL "${defaultModel}" is not in CODEX_ALLOWED_MODELS (${allowed.join(", ")}). ` +
        "Add it to the list or change CODEX_MODEL.",
    );
  }
}

/**
 * The one place a caller-chosen model is checked. Every tool that accepts a
 * `model` calls this before starting a job, so a refused model never becomes a
 * Codex process. Omitting the model is always allowed: the default was checked
 * at startup.
 */
export function validateModel(
  model: string | undefined,
  allowed: readonly string[] = config.allowedModels,
): void {
  if (!model) return;
  if (!SAFE_MODEL.test(model)) throw new UnsafeArgumentError(model);
  if (allowed.length && !allowed.includes(model)) {
    throw new Error(
      `Model "${model}" is not allowed. Allowed models: ${allowed.join(", ")}. ` +
        "Call codex_models to see allowed values.",
    );
  }
}

/** The text codex_models returns. The Rust service writes the same lines. */
export function modelsReport(): string {
  return [
    `allowed_models: ${config.allowedModels.length ? config.allowedModels.join(", ") : "any (no allowlist set)"}`,
    `default_model: ${config.model || "Codex CLI default"}`,
    `reasoning_efforts: ${REASONING_EFFORTS.join(", ")}`,
    "default_reasoning_effort: default",
    "",
    "Pass model and reasoning_effort on codex_run or codex_generate_image to choose them per task.",
  ].join("\n");
}
