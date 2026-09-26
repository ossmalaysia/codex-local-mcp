import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { jobIdOf as jobId, resultText as text, useMcpClient } from "./mcp-client.js";
// @ts-expect-error - plain JS test helper
import { installFakeCodex, makeRoot } from "./setup-fake-codex.mjs";

// Its own file on purpose: vitest gives each file a fresh module instance, so
// the job registry starts empty. Sharing a file let a previous test's
// still-settling job count against the limit, which made this flaky.
const root: string = makeRoot();
process.env.CODEX_MCP_ROOT = root;
process.env.CODEX_BIN = installFakeCodex();
process.env.CODEX_MAX_RUNNING_JOBS = "2";

const { call } = useMcpClient("job-limit-test");

it("caps how many jobs run at once", async () => {
  const a = await call("codex_run", { prompt: "SLOW:2500", workspace: "cap-a", wait_sec: 0 });
  const b = await call("codex_run", { prompt: "SLOW:2500", workspace: "cap-b", wait_sec: 0 });
  const c = await call("codex_run", { prompt: "SLOW:2500", workspace: "cap-c", wait_sec: 0 });

  expect(text(a)).toContain("status: running");
  expect(text(b)).toContain("status: running");
  expect(c.isError).toBe(true);
  expect(text(c)).toMatch(/already running \(limit 2\)/);
  // The refused job never ran.
  expect(fs.existsSync(path.join(root, "cap-c", "notes.txt"))).toBe(false);

  await call("codex_job_result", { job_id: jobId(a), wait_sec: 20 });
  await call("codex_job_result", { job_id: jobId(b), wait_sec: 20 });
}, 20_000);
