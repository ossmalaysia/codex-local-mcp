import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { resultText, useMcpClient } from "./mcp-client.js";
// @ts-expect-error - plain JS test helper
import { installFakeCodex, makeRoot } from "./setup-fake-codex.mjs";

// config reads env at import time, so the environment must be set up first.
// No allowlist and no default model: the behaviour before CODEX_ALLOWED_MODELS.
const root: string = makeRoot();
process.env.CODEX_MCP_ROOT = root;
process.env.CODEX_BIN = installFakeCodex();
delete process.env.CODEX_ALLOWED_MODELS;
delete process.env.CODEX_MODEL;

const mcp = useMcpClient("models-test");

describe("codex_models without an allowlist", () => {
  it("reports no restriction and the Codex CLI default", async () => {
    const result = await mcp.call("codex_models", {});

    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toBe(
      [
        "allowed_models: any (no allowlist set)",
        "default_model: Codex CLI default",
        "reasoning_efforts: default, none, minimal, low, medium, high, xhigh",
        "default_reasoning_effort: default",
        "",
        "Pass model and reasoning_effort on codex_run or codex_generate_image to choose them per task.",
      ].join("\n"),
    );
  });

  it("is listed after the existing tools", async () => {
    const { tools } = await mcp.client().listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "codex_run",
      "codex_generate_image",
      "codex_job_result",
      "codex_read_artifact",
      "codex_models",
    ]);
  });

  it("passes any well-formed model through to Codex", async () => {
    const result = await mcp.call("codex_run", {
      prompt: "hello",
      workspace: "any-model",
      model: "some-model",
      wait_sec: 20,
    });

    expect(result.isError).toBeFalsy();
    const notes = fs.readFileSync(path.join(root, "any-model", "notes.txt"), "utf8");
    expect(notes).toContain('"--model","some-model"');
  });
});
