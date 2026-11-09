import { describe, expect, it } from "vitest";
// @ts-expect-error - plain JS test helper
import { installFakeCodex, makeRoot } from "./setup-fake-codex.mjs";
import { resultText, useMcpClient } from "./mcp-client.js";

// A broken CODEX_PROJECTS must not stop the server, only the tools that need it.
process.env.CODEX_MCP_ROOT = makeRoot();
process.env.CODEX_BIN = installFakeCodex();
process.env.CODEX_PROJECTS = "{not json";

const { call } = useMcpClient("coding-task-config-test");

describe("invalid CODEX_PROJECTS", () => {
  it("leaves the server running and explains the problem in both tools", async () => {
    const listed = await call("codex_projects", {});
    expect(listed.isError).toBe(true);
    expect(resultText(listed)).toContain("CODEX_PROJECTS is not valid JSON");

    const task = await call("codex_task", { project: "demo", ref: "main", task: "x" });
    expect(task.isError).toBe(true);
    expect(resultText(task)).toContain("CODEX_PROJECTS is not valid JSON");
    expect(resultText(task)).not.toContain("job_id");

    // Other tools are unaffected.
    const run = await call("codex_run", { prompt: "hello", wait_sec: 30 });
    expect(run.isError).toBe(false);
  });

  it("names what is wrong with a project entry", async () => {
    // Imported here, not at the top: config reads the environment at import.
    const { parseProjects } = await import("../src/projects.js");
    const cases: Array<[unknown, RegExp]> = [
      [[], /must be a JSON object/],
      [{ "bad name": { path: "/x" } }, /invalid name/],
      [{ "..": { path: "/x" } }, /invalid name/],
      [{ demo: { path: "relative/path" } }, /absolute path/],
      [{ demo: "/x" }, /must be an object/],
      [{ demo: { path: "/x", setup: 3 } }, /setup/],
      [{ demo: { path: "/x", checks: { "a b": "npm test" } } }, /invalid check name/],
      [{ demo: { path: "/x", checks: { test: "" } } }, /check "test"/],
      [{ demo: { path: "/x", extra: true } }, /unknown field "extra"/],
    ];
    for (const [value, message] of cases) {
      const parsed = parseProjects(JSON.stringify(value));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(message);
    }
    expect(parseProjects("").ok).toBe(true);
    // Windows-style absolute paths are only absolute on Windows; use a POSIX one here.
    expect(parseProjects(JSON.stringify({ "my.project_1-a": { path: process.cwd(), checks: { "unit-test": "npm test" } } })).ok).toBe(true);
  });
});
