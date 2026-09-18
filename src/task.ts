import { config } from "./config.js";
import { capOutput, runCodex } from "./codex.js";
import { collectArtifacts, type ArtifactReport } from "./artifacts.js";
import { changedFiles, ensureWorkspace, resolveWorkspace, snapshot } from "./workspace.js";

export interface TaskInput {
  prompt: string;
  workspace?: string;
  timeout_sec?: number;
  model?: string;
}

export interface TaskResult {
  workspace: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
  artifacts: ArtifactReport;
}

function clampTimeout(requested?: number): number {
  if (!requested || !Number.isFinite(requested) || requested <= 0) return config.defaultTimeoutSec;
  return Math.min(requested, config.maxTimeoutSec);
}

/**
 * One Codex task: prepare the workspace, snapshot it, run codex, then report
 * whatever changed on disk. The before/after diff is what makes artifact
 * discovery independent of anything codex prints.
 */
export async function executeTask(input: TaskInput): Promise<TaskResult> {
  const workspace = resolveWorkspace(input.workspace);
  await ensureWorkspace(workspace);

  const before = await snapshot(workspace);
  const run = await runCodex({
    prompt: input.prompt,
    cwd: workspace,
    timeoutSec: clampTimeout(input.timeout_sec),
    model: input.model,
  });
  const after = await snapshot(workspace);

  const artifacts = await collectArtifacts(workspace, changedFiles(before, after));

  const parts = [run.stdout.trim(), run.stderr.trim() ? `[stderr]\n${run.stderr.trim()}` : ""];
  return {
    workspace,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    durationMs: run.durationMs,
    output: capOutput(parts.filter(Boolean).join("\n\n")) || "(codex produced no output)",
    artifacts,
  };
}

/**
 * A thin pass-through: the caller's prompt goes to Codex as written. The only
 * additions are where to put the files and the speed/size knobs.
 */
export function imagePromptTemplate(
  description: string,
  count: number,
  size?: string,
  quality?: string,
): string {
  const lines = [
    count > 1 ? `Generate ${count} images: ${description}` : `Generate an image: ${description}`,
  ];
  if (size) lines.push(`Size: ${size}.`);
  if (quality) lines.push(`Quality: ${quality}.`);
  lines.push("Save the image file(s) into ./output/ in the current directory.");
  return lines.join("\n");
}
