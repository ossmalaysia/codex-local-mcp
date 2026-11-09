import { spawn } from "node:child_process";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { BoundedBuffer, childEnv, killTree } from "./codex.js";
import { assertInsideRoot } from "./workspace.js";

/**
 * Git operations for codex_task: fetch a ref into a throwaway worktree of the
 * user's own clone, turn what Codex changed into a patch, and clean up.
 *
 * These run OUTSIDE the Codex sandbox, with the user's git credentials, so
 * none of them may execute repository code:
 *
 * - Hooks are disabled. A clone can set core.hooksPath to a tracked folder
 *   (husky does), and `worktree add` would then run a post-checkout hook from
 *   the fetched ref, which is caller-controlled. hooksPath points BELOW the git
 *   executable, a regular file, so no hook can ever exist there: an empty
 *   directory would have to live somewhere, and every directory a Codex run can
 *   write to (its workspace, the temp directory) is somewhere it could plant one.
 * - Diffs use --no-ext-diff and --no-textconv, so attributes in the worktree
 *   cannot select a diff driver.
 * - No shell. git is an absolute executable (config.gitBin), spawned directly,
 *   with the root as its working directory and the clone given by -C.
 */

export class GitError extends Error {}

const GIT_TIMEOUT_MS = 300_000;

function gitBase(): string[] {
  return [
    "-c",
    `core.hooksPath=${path.join(config.gitBin, "no-hooks")}`,
    "-c",
    "core.fsmonitor=false",
  ];
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Run git and collect its output. Rejects only when git cannot be started.
 * With `toFile`, stdout goes to that open file instead, unbounded and intact:
 * a patch must never be cut short in memory.
 */
export function git(cwd: string, args: string[], toFile?: FileHandle): Promise<GitResult> {
  if (!path.isAbsolute(config.gitBin)) {
    return Promise.reject(
      new GitError(`Could not find git ("${config.gitBin}"). Install git or set CODEX_GIT_BIN to its full path.`),
    );
  }
  return new Promise((resolve, reject) => {
    const env = childEnv();
    // Never wait on an interactive credential prompt nobody can answer.
    env.GIT_TERMINAL_PROMPT = "0";
    const child = spawn(config.gitBin, [...gitBase(), "-C", cwd, ...args], {
      // Like Codex, never a task workspace: see childEnv and runCodex.
      cwd: config.root,
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = new BoundedBuffer(1_000_000);
    const stderr = new BoundedBuffer(20_000);
    let settled = false;
    let writing = Promise.resolve();
    const timer = setTimeout(() => {
      if (child.pid) killTree(child.pid);
    }, GIT_TIMEOUT_MS);
    timer.unref();
    child.stdout.on("data", (b: Buffer) => {
      if (!toFile) return stdout.push(b.toString("utf8"));
      // Backpressure: pause git while the chunk is written, in order.
      child.stdout.pause();
      writing = writing
        .then(() => toFile.write(b))
        .then(() => undefined)
        .finally(() => child.stdout.resume());
    });
    child.stderr.on("data", (b: Buffer) => stderr.push(b.toString("utf8")));
    // An unhandled launch failure would terminate the server.
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new GitError(`git failed to start: ${err.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      writing.then(
        () => resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code }),
        (err: Error) => reject(new GitError(`Could not save git output: ${err.message}`)),
      );
    });
  });
}

async function gitOk(cwd: string, args: string[], what: string, toFile?: FileHandle): Promise<string> {
  const result = await git(cwd, args, toFile);
  if (result.code !== 0) {
    throw new GitError(`${what} failed: ${result.stderr.trim() || `git exited with ${result.code}`}`);
  }
  return result.stdout;
}

/**
 * One git operation at a time per clone. FETCH_HEAD and the worktree list are
 * shared state in the clone, so two jobs fetching at once could each check out
 * the other's commit.
 */
const projectLocks = new Map<string, Promise<unknown>>();
export function withProjectLock<T>(clone: string, fn: () => Promise<T>): Promise<T> {
  // Windows paths are case-insensitive; one clone must map to one lock.
  const key = process.platform === "win32" ? clone.toLowerCase() : clone;
  const previous = projectLocks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  projectLocks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export interface Worktree {
  dir: string;
  base: string;
}

/**
 * Fetch `ref` from origin into the user's clone and check it out, detached,
 * in a fresh worktree at `dir`. Fetching uses the user's own credentials and
 * runs no repository code.
 */
export async function createWorktree(clone: string, ref: string, dir: string): Promise<Worktree> {
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await assertInsideRoot(dir);
  return withProjectLock(clone, async () => {
    const fetched = await git(clone, ["fetch", "--no-tags", "--no-recurse-submodules", "origin", ref]);
    if (fetched.code !== 0) {
      throw new GitError(`Could not fetch "${ref}" from origin: ${fetched.stderr.trim() || `git exited with ${fetched.code}`}`);
    }
    // Resolve FETCH_HEAD under the lock; the next fetch overwrites it.
    const base = (await gitOk(clone, ["rev-parse", "--verify", "--end-of-options", "FETCH_HEAD^{commit}"], "Resolving the fetched commit")).trim();
    await gitOk(clone, ["worktree", "add", "--detach", "--", dir, base], "Creating the worktree");
    return { dir, base };
  });
}

/**
 * Everything Codex changed, including new untracked files, as a binary-safe
 * patch against the base commit, written to `patchFile` (which must not exist
 * yet). Returns the diffstat. Staging first is what brings untracked files in;
 * .gitignore still applies, so dependency folders stay out.
 */
export async function collectPatch(dir: string, base: string, patchFile: string): Promise<string> {
  await gitOk(dir, ["add", "-A"], "Staging the changes");
  const diff = ["diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv"];
  // "wx": a fresh file, never one planted in advance (or a link to elsewhere).
  const out = await fs.open(patchFile, "wx");
  try {
    await gitOk(dir, [...diff, "--binary", base, "--"], "Creating the patch", out);
  } finally {
    await out.close();
  }
  return gitOk(dir, [...diff, "--stat=200", base, "--"], "Summarising the patch");
}

/**
 * Remove the worktree and its registration. Called on every path, including
 * failure and timeout. If git cannot remove it (a lingering process holding a
 * file on Windows), the folder is deleted directly and the registration pruned.
 */
export async function removeWorktree(clone: string, dir: string): Promise<void> {
  await withProjectLock(clone, async () => {
    const removed = await git(clone, ["worktree", "remove", "--force", "--", dir]).catch(() => undefined);
    if (removed?.code !== 0) {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    }
    await git(clone, ["worktree", "prune"]).catch(() => undefined);
  });
}
