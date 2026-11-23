import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { jobIdOf as jobId, resultText as text, useMcpClient } from "./mcp-client.js";
// @ts-expect-error - plain JS test helper
import { installFakeCodex, makeRoot } from "./setup-fake-codex.mjs";

// Its own file so the job registry and the running-job cap start clean. A cap
// of one makes "the slot is freed" observable: a second job only starts once
// the cancelled one has settled.
const root: string = makeRoot();
process.env.CODEX_MCP_ROOT = root;
process.env.CODEX_BIN = installFakeCodex();
process.env.CODEX_MAX_RUNNING_JOBS = "1";

const { call } = useMcpClient("job-cancel-test");

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

/** True while the process exists. A zombie on Linux has already exited. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
    } catch {
      return false;
    }
  }
  return true;
}

it("cancels a running job, kills its process tree and frees its slot", async () => {
  const workspace = path.join(root, "cancel-me");
  const started = await call("codex_run", {
    prompt: "private-prompt-sentinel SLEEP",
    workspace: "cancel-me",
    wait_sec: 0,
  });
  expect(text(started)).toContain("status: running");
  const id = jobId(started);

  const pidFile = path.join(workspace, "pids.txt");
  expect(await waitFor(() => fs.existsSync(pidFile), 15_000)).toBe(true);
  const pids = fs.readFileSync(pidFile, "utf8").trim().split(" ").map(Number);
  expect(pids.every(alive)).toBe(true);

  // The cap of one is taken while the job runs.
  const refused = await call("codex_run", { prompt: "quick", workspace: "next", wait_sec: 0 });
  expect(refused.isError).toBe(true);
  expect(text(refused)).toMatch(/already running \(limit 1\)/);

  const running = await call("codex_jobs_list", { status: "running" });
  expect(text(running)).toContain(`job_id: ${id} | tool: codex_run | status: running`);
  expect(text(running)).not.toContain("private-prompt-sentinel");

  const cancelled = await call("codex_job_cancel", { job_id: id });
  expect(cancelled.isError).toBeFalsy();
  expect(text(cancelled)).toContain("status: cancelled");

  // Codex and the grandchild it started are both gone.
  expect(await waitFor(() => !pids.some(alive), 10_000)).toBe(true);

  // The result reads like a timeout, and files written before the cancel stay.
  const result = await call("codex_job_result", { job_id: id, wait_sec: 0 });
  expect(result.isError).toBe(true);
  expect(text(result)).toContain("(CANCELLED - process killed)");
  expect(text(result)).toContain("partial.txt");
  expect(fs.existsSync(path.join(workspace, "partial.txt"))).toBe(true);

  // The slot is free again.
  const next = await call("codex_run", { prompt: "quick", workspace: "next", wait_sec: 20 });
  expect(next.isError).toBeFalsy();
  expect(text(next)).toContain("notes.txt");

  const all = text(await call("codex_jobs_list", {}));
  const lines = all.split("\n");
  // Newest first.
  expect(lines[0]).toMatch(/tool: codex_run \| status: completed \| phase: \S+ \| elapsed: \d+s \| workspace: .*next$/);
  expect(lines[1]).toContain(`job_id: ${id} | tool: codex_run | status: cancelled`);
  expect(all).not.toContain("private-prompt-sentinel");

  const finished = text(await call("codex_jobs_list", { status: "finished" }));
  expect(finished.split("\n")).toHaveLength(2);
  expect(text(await call("codex_jobs_list", { status: "running" }))).toBe("No running jobs.");
}, 40_000);

it("says a finished job has nothing to cancel, without an error", async () => {
  const done = await call("codex_run", { prompt: "quick", workspace: "done", wait_sec: 20 });
  const id = /job_id: (\S+)/.exec(text(await call("codex_jobs_list", {})))![1];
  expect(done.isError).toBeFalsy();

  const result = await call("codex_job_cancel", { job_id: id });
  expect(result.isError).toBeFalsy();
  expect(text(result)).toContain("status: completed");
  expect(text(result)).toMatch(/already finished/);
}, 20_000);

it("rejects an unknown job id with a readable error", async () => {
  const result = await call("codex_job_cancel", { job_id: "no-such-job" });
  expect(result.isError).toBe(true);
  expect(text(result)).toMatch(/Unknown job "no-such-job"/);
});
