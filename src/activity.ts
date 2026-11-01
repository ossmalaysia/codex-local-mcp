/** Private manager telemetry. Never write prompts, command text, credentials, or image data. */
export const ACTIVITY_PREFIX = "codex-local-mcp activity: ";
export type TaskPhase = "queued" | "preparing" | "running" | "running_command" | "writing_files" | "collecting_files";
export type TaskProgress = { phase: TaskPhase; files?: number; exitCode?: number | null; timedOut?: boolean };
export type ActivityEvent = {
  type: "job" | "request";
  id?: string;
  action: string;
  workspace?: string;
  status?: "running" | "completed" | "failed";
  phase?: TaskPhase;
  elapsedMs?: number;
  files?: number;
  exitCode?: number | null;
  timedOut?: boolean;
};
export function emitActivity(event: ActivityEvent): void {
  if (process.env.CODEX_MCP_ACTIVITY !== "1") return;
  try { process.stderr.write(ACTIVITY_PREFIX + JSON.stringify({ v: 1, ...event }) + "\n"); } catch { /* Observability must not interrupt a task. */ }
}

/** Recognize only fixed CLI markers. Discard arbitrary output and oversized lines. */
export class CodexProgress {
  private line = "";
  private overflow = false;
  constructor(private report: (phase: TaskPhase) => void) {}
  push(text: string): void {
    for (const char of text) {
      if (char === "\n") {
        if (!this.overflow) {
          const marker = this.line.trim();
          if (marker === "exec") this.report("running_command");
          else if (marker === "apply patch") this.report("writing_files");
          else if (marker === "codex") this.report("running");
        }
        this.line = ""; this.overflow = false;
      } else if (!this.overflow) {
        if (this.line.length < 512) this.line += char;
        else { this.line = ""; this.overflow = true; }
      }
    }
  }
}
