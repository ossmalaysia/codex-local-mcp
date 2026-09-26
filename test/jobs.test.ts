import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { jobIdOf as jobId, resultText as text, useMcpClient } from "./mcp-client.js";
// @ts-expect-error - plain JS test helper
import { installFakeCodex, makeRoot } from "./setup-fake-codex.mjs";

// config reads env at import time, so the environment must be set up first.
const root: string = makeRoot();
process.env.CODEX_MCP_ROOT = root;
process.env.CODEX_BIN = installFakeCodex();

const mcp = useMcpClient("jobs-test");
const call = mcp.call;


async function waitForFile(file: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fs.existsSync(file);
}

describe("fast tasks", () => {
  it("return the full result directly, with no job id", async () => {
    const result = await call("codex_run", { prompt: "quick", workspace: "fast" });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("files created or changed");
    expect(text(result)).not.toContain("job_id");
  });
});

describe("slow tasks become pollable jobs", () => {
  it("answer quickly with status running instead of blocking", async () => {
    const started = Date.now();
    const result = await call("codex_run", {
      prompt: "work SLOW:2500",
      workspace: "slow",
      wait_sec: 0.5,
    });

    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("status: running");
    expect(text(result)).toContain(path.join(root, "slow"));
    expect(jobId(result)).toMatch(/^[0-9a-f-]{36}$/);

    await call("codex_job_result", { job_id: jobId(result), wait_sec: 20 }); // drain
  }, 20_000);

  it("deliver the full result through codex_job_result, and keep it retrievable", async () => {
    const running = await call("codex_run", {
      prompt: "work SLOW:1500",
      workspace: "collect",
      wait_sec: 0,
    });
    const id = jobId(running);

    const first = await call("codex_job_result", { job_id: id, wait_sec: 20 });
    expect(first.isError).toBeFalsy();
    expect(text(first)).toContain("notes.txt");
    expect(text(first)).not.toContain("status: running");

    // A second poll returns the same finished result rather than an error.
    const second = await call("codex_job_result", { job_id: id, wait_sec: 0 });
    expect(text(second)).toBe(text(first));
  }, 20_000);

  it("report still running when polled before the job finishes", async () => {
    const running = await call("codex_run", {
      prompt: "work SLOW:3000",
      workspace: "poll-early",
      wait_sec: 0,
    });

    const poll = await call("codex_job_result", { job_id: jobId(running), wait_sec: 0 });
    expect(text(poll)).toContain("status: running");

    await call("codex_job_result", { job_id: jobId(running), wait_sec: 20 }); // drain
  }, 20_000);

  it("run the image post-processing inside the job", async () => {
    const running = await call("codex_generate_image", {
      prompt: "a cube SLOW:1500",
      workspace: "image-job",
      size: "800x600",
      open: false,
      wait_sec: 0,
    });
    expect(text(running)).toContain("status: running");

    const done = await call("codex_job_result", { job_id: jobId(running), wait_sec: 20 });
    // Dimension reporting and the mismatch note both come from the job's tail.
    expect(text(done)).toContain("1x1");
    expect(text(done)).toContain("not the requested 800x600");
  }, 20_000);
});

describe("the reported failure: a client that stops waiting", () => {
  it("still finishes the work when the caller times out", async () => {
    // Stands in for a client whose request timeout is shorter than the task,
    // which is what dropped the image generations.
    await expect(
      mcp.client().callTool(
        { name: "codex_run", arguments: { prompt: "work SLOW:2000", workspace: "abandoned" } },
        undefined,
        { timeout: 400 },
      ),
    ).rejects.toThrow();

    expect(await waitForFile(path.join(root, "abandoned", "notes.txt"), 15_000)).toBe(true);
  }, 20_000);
});

describe("job bookkeeping", () => {
  it("rejects an unknown job id with a readable error", async () => {
    const result = await call("codex_job_result", { job_id: "no-such-job" });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Unknown job/);
  });

  it("keeps every wait under the client timeout", async () => {
    const { clampWait } = await import("../src/jobs.js");

    expect(clampWait(undefined)).toBe(45);
    expect(clampWait(999)).toBe(50);
    expect(clampWait(-5)).toBe(0);
    expect(clampWait(10)).toBe(10);
  });
});
