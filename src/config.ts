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
};
