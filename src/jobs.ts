import { randomUUID } from "node:crypto";
import { config } from "./config.js";

/**
 * Long-running work detached from the tool call that started it.
 *
 * MCP clients built on the official SDK abandon a request after 60 seconds by
 * default, and an image generation routinely takes longer. When that happens
 * the work still finishes, but the result has nowhere to go. So every task runs
 * as a job: the starting call waits a bounded time, and if the job is not done
 * it answers with an id the caller can poll instead of being cut off.
 *
 * Jobs live in memory. A server restart loses them, but not their files, which
 * are in the workspace each job reports.
 */

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export interface Job<T> {
  id: string;
  label: string;
  workspace: string;
  startedAt: number;
  finishedAt?: number;
  outcome?: Outcome<T>;
  /** Settles when the job finishes, whether it succeeded or failed. Never rejects. */
  done: Promise<void>;
}

export class JobLimitError extends Error {}

const jobs = new Map<string, Job<unknown>>();

function runningCount(): number {
  let running = 0;
  for (const job of jobs.values()) if (!job.outcome) running++;
  return running;
}

/** Finished jobs are kept for a while so a late poll still gets its result. */
function purgeExpired(now = Date.now()): void {
  const ttl = config.jobRetentionSec * 1000;
  for (const [id, job] of jobs) {
    if (job.finishedAt !== undefined && now - job.finishedAt > ttl) jobs.delete(id);
  }
}

export function startJob<T>(label: string, workspace: string, work: () => Promise<T>): Job<T> {
  purgeExpired();
  const running = runningCount();
  if (running >= config.maxRunningJobs) {
    throw new JobLimitError(
      `${running} Codex jobs are already running (limit ${config.maxRunningJobs}). ` +
        `Wait for one to finish with codex_job_result, then try again.`,
    );
  }

  const job: Job<T> = {
    id: randomUUID(),
    label,
    workspace,
    startedAt: Date.now(),
    done: Promise.resolve(),
  };
  // Promise.resolve().then() also captures a synchronous throw from work().
  job.done = Promise.resolve()
    .then(work)
    .then(
      (value) => {
        job.outcome = { ok: true, value };
      },
      (error: unknown) => {
        job.outcome = { ok: false, error };
      },
    )
    .finally(() => {
      job.finishedAt = Date.now();
    });

  jobs.set(job.id, job as Job<unknown>);
  return job;
}

export function getJob(id: string): Job<unknown> | undefined {
  purgeExpired();
  return jobs.get(id);
}

/** Choose how long a call waits, never exceeding the safe maximum. */
export function clampWait(requested?: number): number {
  const chosen =
    requested !== undefined && Number.isFinite(requested) ? requested : config.waitSec;
  return Math.max(0, Math.min(chosen, config.maxWaitSec));
}

/**
 * Wait up to `waitSec` for the job, stopping early if the caller cancels.
 * Resolves true when the job has finished. Cancelling the wait never cancels
 * the job: that is the point of running it detached.
 */
export async function waitForJob(
  job: Job<unknown>,
  waitSec: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (job.outcome || waitSec <= 0 || signal?.aborted) return Boolean(job.outcome);

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitSec * 1000);
    timer.unref();
    onAbort = () => resolve();
    signal?.addEventListener("abort", onAbort, { once: true });
  });

  await Promise.race([job.done, stop]);
  clearTimeout(timer);
  if (onAbort) signal?.removeEventListener("abort", onAbort);
  return Boolean(job.outcome);
}
