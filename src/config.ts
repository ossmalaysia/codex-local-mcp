import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolve the Codex executable to an absolute path once, at startup.
 *
 * A bare command name is dangerous: it is looked up at spawn time, and on
 * Windows the lookup includes the child's working directory, which is a
 * workspace Codex itself can write to. A previous run could drop a `codex.cmd`
 * there and the next run would execute it outside any sandbox. Relative PATH
 * entries are skipped for the same reason.
 */
function resolveCodexBin(raw: string): string {
  if (path.isAbsolute(raw)) return raw;

  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];

  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, raw + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Keep looking.
      }
    }
  }
  // Not found. Return the bare name so the launch fails with a clear message
  // rather than silently resolving against an untrusted directory later.
  return raw;
}

export const config = {
  /** Absolute path to the Codex executable; see resolveCodexBin. */
  codexBin: resolveCodexBin(process.env.CODEX_BIN || "codex"),
  /** Every workspace lives under this root; callers cannot escape it. */
  root: path.resolve(
    process.env.CODEX_MCP_ROOT || path.join(os.homedir(), ".codex-mcp", "workspaces"),
  ),
  /** Empty means "whatever codex is configured to use". */
  model: process.env.CODEX_MODEL || "",
  defaultTimeoutSec: num("CODEX_TIMEOUT_SEC", 300),
  maxTimeoutSec: num("CODEX_MAX_TIMEOUT_SEC", 1800),
  /** Codex output is capped so a runaway build log cannot flood the caller. */
  maxOutputChars: num("CODEX_MAX_OUTPUT_CHARS", 40_000),
  /**
   * Budgets are measured in BASE64 CHARACTERS, not file bytes, because that is
   * what the client actually receives and counts. Encoding inflates by 4/3, so
   * a budget expressed in file bytes silently overshoots by a third.
   */
  maxInlineImageB64: num("CODEX_MAX_INLINE_IMAGE_B64", 350_000),
  /** Ceiling for ALL inlined images in one response combined. */
  maxResponseB64: num("CODEX_MAX_RESPONSE_B64", 750_000),
  /** Cap on how many changed files we report. */
  maxReportedFiles: num("CODEX_MAX_REPORTED_FILES", 200),
  /** Image APIs need the network; workspace-write blocks it unless we opt in. */
  networkAccess: process.env.CODEX_NETWORK_ACCESS !== "false",
  /**
   * How long a tool call waits for its job before answering "still running".
   * Must stay under the 60-second request timeout that MCP clients built on
   * the official SDK use by default, with room for the response to travel.
   */
  waitSec: num("CODEX_WAIT_SEC", 45),
  maxWaitSec: 50,
  /**
   * Jobs outlive the call that started them, so a caller could otherwise start
   * Codex processes faster than they finish. This bounds how many run at once.
   */
  maxRunningJobs: num("CODEX_MAX_RUNNING_JOBS", 4),
  /** How long a finished job's result stays retrievable. */
  jobRetentionSec: num("CODEX_JOB_RETENTION_SEC", 3600),
};
