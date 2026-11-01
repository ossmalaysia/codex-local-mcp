import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeCodex, makeRoot } from "./setup-fake-codex.mjs";
import { useMcpClient } from "./mcp-client.js";

process.env.CODEX_MCP_ROOT = makeRoot();
process.env.CODEX_BIN = installFakeCodex();
const { ACTIVITY_PREFIX, CodexProgress, emitActivity } = await import("../src/activity.js");
const { startJob, reportJob } = await import("../src/jobs.js");
const mcp = useMcpClient("activity-test");
afterEach(() => { delete process.env.CODEX_MCP_ACTIVITY; vi.restoreAllMocks(); vi.useRealTimers(); });

function capture() {
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((value: string | Uint8Array) => { lines.push(value.toString()); return true; }) as typeof process.stderr.write);
  return { lines, events: () => lines.filter(line => line.startsWith(ACTIVITY_PREFIX)).map(line => JSON.parse(line.slice(ACTIVITY_PREFIX.length))) };
}
describe("private manager activity", () => {
  it("does not write activity unless the manager enables it", () => {
    const output = capture(); emitActivity({ type: "request", action: "tools/list" }); expect(output.lines).toEqual([]);
  });
  it("recognizes split CLI markers and discards command text and large encoded lines", () => {
    const phases: string[] = []; const parser = new CodexProgress(phase => phases.push(phase));
    parser.push("ex"); parser.push("ec\nsecret command\napply patch\ncodex\n");
    parser.push("A".repeat(100000) + "exec\n"); parser.push("exec\n");
    expect(phases).toEqual(["running_command", "writing_files", "running", "running_command"]);
  });
  it("reports queued, heartbeat, and completed events with file and exit counts", async () => {
    process.env.CODEX_MCP_ACTIVITY = "1"; vi.useFakeTimers(); const output = capture();
    let finish!: () => void;
    const job = startJob("codex_run", "/workspace/task", async current => {
      reportJob(current, { phase: "running" }); await new Promise<void>(resolve => { finish = resolve; });
      reportJob(current, { phase: "collecting_files", files: 2, exitCode: 0 }); return { isError: false };
    });
    await vi.advanceTimersByTimeAsync(5000); finish(); await job.done;
    const events = output.events(); expect(events[0].phase).toBe("queued");
    expect(events.some(event => event.status === "running" && event.elapsedMs >= 5000)).toBe(true);
    expect(events.at(-1)).toMatchObject({ id: job.id, status: "completed", files: 2, exitCode: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reports an error tool result and a thrown exception as failed", async () => {
    process.env.CODEX_MCP_ACTIVITY = "1"; const output = capture();
    const errorResult = startJob("codex_run", "/workspace/task", async () => ({ isError: true })); await errorResult.done;
    const exception = startJob("codex_run", "/workspace/other", async () => { throw new Error("private failure text"); }); await exception.done;
    expect(output.events().filter(event => event.status === "failed")).toHaveLength(2);
    expect(output.lines.join("")).not.toContain("private failure text");
  });
  it("streams task progress before a real child process finishes and omits its prompt", async () => {
    process.env.CODEX_MCP_ACTIVITY = "1"; const output = capture();
    await mcp.call("codex_run", { prompt: "activity secret prompt SLOW:500", workspace: "activity-work", wait_sec: 0 });
    expect(output.events().some(event => event.status === "running")).toBe(true);
    const jobId = output.events()[0].id;
    await mcp.call("codex_job_result", { job_id: jobId, wait_sec: 15 });
    const events = output.events(); expect(events.some(event => event.phase === "preparing")).toBe(true);
    expect(events.at(-1)).toMatchObject({ id: jobId, status: "completed", exitCode: 0 });
    expect(events.at(-1).files).toBeGreaterThan(0);
    expect(output.lines.join("")).not.toContain("activity secret prompt");
  }, 20000);
});
