import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { resultText, useMcpClient } from "./mcp-client.js";
// @ts-expect-error - plain JS test helper
import { installFakeCodex, makeRoot } from "./setup-fake-codex.mjs";

// config reads env at import time, so the environment must be set up first.
// Entries are trimmed, so the spaces here are deliberate.
const root: string = makeRoot();
process.env.CODEX_MCP_ROOT = root;
process.env.CODEX_BIN = installFakeCodex();
process.env.CODEX_ALLOWED_MODELS = " gpt-5-codex , gpt-5 ";
process.env.CODEX_MODEL = "gpt-5";

const mcp = useMcpClient("model-allowlist-test");

/** The fake Codex records its prompt and argv in notes.txt. */
function notes(workspace: string): string {
  return fs.readFileSync(path.join(root, workspace, "notes.txt"), "utf8");
}

describe("codex_models with an allowlist", () => {
  it("lists the allowed models and the configured default", async () => {
    const text = resultText(await mcp.call("codex_models", {}));

    expect(text).toContain("allowed_models: gpt-5-codex, gpt-5\n");
    expect(text).toContain("default_model: gpt-5\n");
    expect(text).toContain("reasoning_efforts: default, none, minimal, low, medium, high, xhigh\n");
    expect(text).toContain("default_reasoning_effort: default\n");
  });

  it("points callers at codex_models from the model parameters", async () => {
    const { tools } = await mcp.client().listTools();
    for (const name of ["codex_run", "codex_generate_image"]) {
      const props = tools.find((t) => t.name === name)?.inputSchema.properties as Record<
        string,
        { description?: string }
      >;
      expect(props.model.description).toMatch(/call codex_models to see allowed values/i);
      expect(props.reasoning_effort.description).toMatch(/call codex_models to see allowed values/i);
    }
  });
});

describe("the allowlist is enforced before a job starts", () => {
  for (const tool of ["codex_run", "codex_generate_image"]) {
    it(`${tool} refuses a model that is not listed`, async () => {
      const workspace = `refused-${tool}`;
      const result = await mcp.call(tool, {
        prompt: "hello",
        workspace,
        model: "gpt-4o",
        open: tool === "codex_generate_image" ? false : undefined,
      });

      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('Model "gpt-4o" is not allowed');
      expect(resultText(result)).toContain("Allowed models: gpt-5-codex, gpt-5");
      expect(resultText(result)).not.toMatch(/job_id/);
      // No Codex run happened: the fake would have written notes.txt.
      expect(fs.existsSync(path.join(root, workspace, "notes.txt"))).toBe(false);
    });
  }

  it("passes an allowed model and reasoning effort to the Codex command line", async () => {
    const result = await mcp.call("codex_run", {
      prompt: "hello",
      workspace: "allowed",
      model: "gpt-5-codex",
      reasoning_effort: "high",
      wait_sec: 20,
    });

    expect(result.isError).toBeFalsy();
    expect(notes("allowed")).toContain('"--model","gpt-5-codex"');
    expect(notes("allowed")).toContain('"model_reasoning_effort=high"');
  });

  it("uses CODEX_MODEL when the caller does not choose", async () => {
    const result = await mcp.call("codex_run", { prompt: "hello", workspace: "default", wait_sec: 20 });

    expect(result.isError).toBeFalsy();
    expect(notes("default")).toContain('"--model","gpt-5"');
  });
});

describe("allowlist configuration", () => {
  it("refuses a malformed entry and a default model outside the list", async () => {
    const { assertModelConfig } = await import("../src/models.js");

    expect(() => assertModelConfig(["gpt-5", "bad model"], "")).toThrow(
      /CODEX_ALLOWED_MODELS contains "bad model"/,
    );
    expect(() => assertModelConfig(["gpt-5"], "o3")).toThrow(
      /CODEX_MODEL "o3" is not in CODEX_ALLOWED_MODELS/,
    );
    expect(() => assertModelConfig(["gpt-5"], "")).not.toThrow();
    expect(() => assertModelConfig([], "anything")).not.toThrow();
  });
});
