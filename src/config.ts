import os from "node:os";
import path from "node:path";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  /** Codex executable. Override if it is not on PATH. */
  codexBin: process.env.CODEX_BIN || "codex",
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
  /** Images below this size are inlined as base64; bigger ones are path-only. */
  maxInlineImageBytes: num("CODEX_MAX_INLINE_IMAGE_BYTES", 1_048_576),
  /** Cap on how many changed files we report. */
  maxReportedFiles: num("CODEX_MAX_REPORTED_FILES", 200),
  /** Image APIs need the network; workspace-write blocks it unless we opt in. */
  networkAccess: process.env.CODEX_NETWORK_ACCESS !== "false",
};
