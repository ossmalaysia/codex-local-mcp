import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { capOutput, runCodex } from "./codex.js";
import { readArtifact } from "./artifacts.js";
import { collectPatch, createWorktree, removeWorktree } from "./gitwork.js";
import type { Project } from "./projects.js";
import { clampTimeout } from "./task.js";
import type { TaskProgress } from "./activity.js";

/**
 * codex_task: a coding task on a real git project. Fetch the caller's ref into
 * a fresh worktree of the user's clone, let Codex work there inside its
 * sandbox, and hand back its final message plus a patch. Nothing is pushed.
 */

export interface CodingTaskInput {
  jobId: string;
  project: Project;
  ref: string;
  task: string;
  mode: "edit" | "review";
  acceptance?: string;
  checks: string[];
  returnPatch: boolean;
  model?: string;
  reasoning_effort?: string;
  timeout_sec?: number;
  onProgress?: (progress: TaskProgress) => void;
}

export interface CodingTaskResult {
  jobId: string;
  project: string;
  ref: string;
  base: string;
  mode: "edit" | "review";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  summary: string;
  diffstat: string;
  checks: Array<{ name: string; command: string }>;
  /** Absent in review mode. */
  patchFile?: string;
  patchBytes?: number;
  /** The patch text, when it was inlined. */
  patch?: string;
  /** Why the patch was not inlined, when it was not. */
  patchNote?: string;
}

/** Where codex_task keeps its worktrees, patches and final messages. */
export function tasksDir(project: string): string {
  return path.join(config.root, "tasks", project);
}

/**
 * The task goes to Codex as written. The only additions are the caller's own
 * acceptance text and the project's configured setup and check commands.
 *
 * Setup and checks are repository code chosen by the caller, so they are never
 * run by this server, which works outside the Codex sandbox. Codex runs them
 * inside its sandbox and reports the outcome itself; see SECURITY.md.
 */
export function buildTaskPrompt(
  task: string,
  acceptance: string | undefined,
  setup: string | undefined,
  checks: Array<{ name: string; command: string }>,
): string {
  const parts = [task];
  if (acceptance) parts.push(`Done when:\n${acceptance}`);
  if (setup) parts.push(`First run: ${setup}`);
  if (checks.length) {
    parts.push(
      "Before finishing, run these checks and report pass/fail:\n" +
        checks.map((c) => `- ${c.name}: ${c.command}`).join("\n"),
    );
  }
  return parts.join("\n\n");
}

/**
 * Package managers write their caches inside a per-project folder that the
 * sandbox allows, so installs work under workspace-write and later tasks on
 * the same project reuse what earlier ones downloaded.
 */
export function cacheEnv(cache: string): Record<string, string> {
  return {
    npm_config_cache: path.join(cache, "npm"),
    YARN_CACHE_FOLDER: path.join(cache, "yarn"),
    npm_config_store_dir: path.join(cache, "pnpm-store"),
    PNPM_STORE_DIR: path.join(cache, "pnpm-store"),
    PIP_CACHE_DIR: path.join(cache, "pip"),
    UV_CACHE_DIR: path.join(cache, "uv"),
  };
}

export async function executeCodingTask(input: CodingTaskInput): Promise<CodingTaskResult> {
  const started = Date.now();
  const { project, jobId } = input;
  const dir = tasksDir(project.name);
  const worktree = path.join(dir, jobId);
  // Both outside the worktree, so neither ends up in the patch, and outside
  // anything the sandbox lets Codex write.
  const lastMessage = path.join(dir, `${jobId}.last.md`);
  const patchFile = path.join(dir, `${jobId}.patch`);
  const cache = path.join(config.root, ".cache", project.name);
  const checks = input.checks.map((name) => ({ name, command: project.checks[name] }));

  input.onProgress?.({ phase: "preparing" });
  try {
    const { base } = await createWorktree(project.path, input.ref, worktree);
    await fs.mkdir(cache, { recursive: true });
    input.onProgress?.({ phase: "running" });
    const run = await runCodex({
      prompt: buildTaskPrompt(input.task, input.acceptance, project.setup, checks),
      cwd: worktree,
      timeoutSec: clampTimeout(input.timeout_sec),
      model: input.model,
      reasoningEffort: input.reasoning_effort,
      onProgress: (phase) => input.onProgress?.({ phase }),
      sandbox: input.mode === "review" ? { readOnly: true } : { writableRoots: [cache] },
      env: cacheEnv(cache),
      outputLastMessage: lastMessage,
    });
    input.onProgress?.({ phase: "collecting_files", exitCode: run.exitCode, timedOut: run.timedOut });

    let summary: string | undefined;
    try {
      summary = (await readArtifact(lastMessage, 1_000_000)).text?.trim();
    } catch {
      // No final message (a timeout or a failed run); fall back to the log.
    }
    if (!summary) {
      summary =
        [run.stdout.trim(), run.stderr.trim() ? `[stderr]\n${run.stderr.trim()}` : ""]
          .filter(Boolean)
          .join("\n\n") || "(codex produced no output)";
    }

    const result: CodingTaskResult = {
      jobId,
      project: project.name,
      ref: input.ref,
      base,
      mode: input.mode,
      exitCode: run.exitCode,
      signal: run.signal,
      timedOut: run.timedOut,
      durationMs: 0,
      summary: capOutput(summary),
      diffstat: "",
      checks,
    };

    if (input.mode === "edit") {
      result.diffstat = (await collectPatch(worktree, base, patchFile)).trim();
      result.patchFile = patchFile;
      result.patchBytes = (await fs.stat(patchFile)).size;
      if (!input.returnPatch) {
        result.patchNote = "not inlined because return is \"summary\"";
      } else if (result.patchBytes > config.maxPatchChars) {
        result.patchNote =
          `not inlined: ${result.patchBytes} bytes is over the ${config.maxPatchChars}-character budget ` +
          "(CODEX_MAX_PATCH_CHARS)";
      } else {
        // A UTF-8 file of N bytes decodes to at most N characters.
        result.patch = (await readArtifact(patchFile, config.maxPatchChars)).text ?? "";
      }
    }
    result.durationMs = Date.now() - started;
    return result;
  } finally {
    // The patch and final message are saved; the checkout is not needed. This
    // also runs when the fetch or checkout failed part-way.
    await removeWorktree(project.path, worktree);
  }
}
