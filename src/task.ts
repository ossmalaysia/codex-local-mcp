import { config } from "./config.js";
import { runCodex } from "./codex.js";
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
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
  artifacts: ArtifactReport;
}

/**
 * Clamp AFTER choosing the value, so a default larger than the configured
 * maximum is still capped. Doing it in the default branch would let
 * CODEX_TIMEOUT_SEC quietly exceed CODEX_MAX_TIMEOUT_SEC.
 */
export function clampTimeout(requested?: number): number {
  const chosen =
    requested && Number.isFinite(requested) && requested > 0 ? requested : config.defaultTimeoutSec;
  // setTimeout silently fires immediately above 2^31-1 ms.
  const ceiling = Math.min(config.maxTimeoutSec, 2 ** 31 / 1000 - 1);
  return Math.max(1, Math.min(chosen, ceiling));
}

/**
 * One run at a time per workspace. Without this, two concurrent tasks sharing a
 * workspace each diff against the other's writes and report the other's files
 * as their own artifacts.
 */
const workspaceLocks = new Map<string, Promise<unknown>>();

function withWorkspaceLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = workspaceLocks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  // Keep the chain alive but never let a rejection escape into the next waiter.
  workspaceLocks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * One Codex task: prepare the workspace, snapshot it, run codex, then report
 * whatever changed on disk. The before/after diff is what makes artifact
 * discovery independent of anything codex prints.
 */
export async function executeTask(input: TaskInput): Promise<TaskResult> {
  const workspace = resolveWorkspace(input.workspace);

  return withWorkspaceLock(workspace.toLowerCase(), async () => {
    const real = await ensureWorkspace(workspace);

    const before = await snapshot(real);
    const run = await runCodex({
      prompt: input.prompt,
      cwd: real,
      timeoutSec: clampTimeout(input.timeout_sec),
      model: input.model,
    });
    const after = await snapshot(real);

    const artifacts = await collectArtifacts(real, changedFiles(before, after));

    const parts = [run.stdout.trim(), run.stderr.trim() ? `[stderr]\n${run.stderr.trim()}` : ""];
    return {
      workspace: real,
      exitCode: run.exitCode,
      signal: run.signal,
      timedOut: run.timedOut,
      durationMs: run.durationMs,
      output: parts.filter(Boolean).join("\n\n") || "(codex produced no output)",
      artifacts,
    };
  });
}

/** True when the run did not complete normally, including signal deaths. */
export function taskFailed(result: TaskResult): boolean {
  if (result.timedOut || result.signal) return true;
  // A null exit code with no signal means the process went away unexplained.
  return result.exitCode === null || result.exitCode !== 0;
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
