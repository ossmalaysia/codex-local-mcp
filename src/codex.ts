import { spawn } from "node:child_process";
import path from "node:path";
import { config } from "./config.js";

export interface RunOptions {
  prompt: string;
  cwd: string;
  timeoutSec: number;
  model?: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  command: string;
}

export class CodexNotFoundError extends Error {
  constructor(bin: string) {
    super(
      `Could not run "${bin}". Install the Codex CLI (npm i -g @openai/codex), run "codex login", ` +
        `or set CODEX_BIN to its full path.`,
    );
  }
}

/**
 * Values that reach a Windows command line must not be able to smuggle in
 * environment expansion or quoting tricks. Model names are the only free-form
 * argument we pass, so they are restricted to characters real model ids use.
 */
const SAFE_MODEL = /^[A-Za-z0-9._:/-]{1,128}$/;

export class UnsafeArgumentError extends Error {
  constructor(value: string) {
    super(`Refusing to pass model "${value}": only letters, digits and . _ : / - are allowed.`);
  }
}

function buildArgs(opts: RunOptions): string[] {
  const args = [
    "exec",
    "--cd",
    opts.cwd,
    "--sandbox",
    "workspace-write",
    // Workspaces are plain folders, not repos; without this codex refuses to run.
    "--skip-git-repo-check",
  ];
  if (config.networkAccess) {
    // workspace-write denies network by default, but image APIs need it.
    args.push("-c", "sandbox_workspace_write.network_access=true");
  }
  const model = opts.model || config.model;
  if (model) {
    if (!SAFE_MODEL.test(model)) throw new UnsafeArgumentError(model);
    args.push("--model", model);
  }
  // Trailing "-" makes codex read the prompt from stdin, so no shell quoting of
  // untrusted prompt text is ever needed.
  args.push("-");
  return args;
}

function systemDir(): string {
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32");
}

/**
 * Windows spawn cannot kill a process tree, and codex spawns node/python
 * children. Both the launch failure and the exit status are handled here: an
 * unhandled child "error" event would terminate this server.
 */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    const killer = spawn(
      path.join(systemDir(), "taskkill.exe"),
      ["/pid", String(pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    killer.on("error", (err) => {
      console.error("codex-local-mcp: could not run taskkill:", err);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/**
 * With verbatim arguments, Windows hands the command line to cmd.exe as written,
 * so any path containing a space would split into two arguments. Quote them all.
 * The prompt travels on stdin and is never quoted.
 */
export function quoteForShell(value: string): string {
  if (value !== "" && !/[\s"^&|<>()%!]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * The child's PATH must be usable (codex.cmd re-invokes node) without ever
 * containing a relative entry: "." would resolve against the working directory,
 * and a workspace is something Codex itself can write to.
 */
export function childEnv(): NodeJS.ProcessEnv {
  const extra = [path.dirname(config.codexBin), path.dirname(process.execPath)];
  if (process.platform === "win32") extra.push(systemDir());

  const current = process.env.PATH || process.env.Path || "";
  const merged = [...extra, ...current.split(path.delimiter)]
    .filter((entry) => entry && path.isAbsolute(entry))
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .join(path.delimiter);
  return { ...process.env, PATH: merged, Path: merged };
}

/** Keeps the head and tail of a stream without ever holding all of it in memory. */
export class BoundedBuffer {
  private head = "";
  private tail = "";
  private dropped = 0;

  constructor(private readonly max: number) {}

  push(chunk: string): void {
    const headRoom = Math.floor(this.max / 2) - this.head.length;
    if (headRoom > 0) {
      this.head += chunk.slice(0, headRoom);
      chunk = chunk.slice(headRoom);
      if (!chunk) return;
    }
    this.tail += chunk;
    const tailMax = Math.ceil(this.max / 2);
    if (this.tail.length > tailMax) {
      this.dropped += this.tail.length - tailMax;
      this.tail = this.tail.slice(-tailMax);
    }
  }

  toString(): string {
    if (!this.dropped) return this.head + this.tail;
    return `${this.head}\n\n...[${this.dropped} characters omitted]...\n\n${this.tail}`;
  }
}

export function runCodex(opts: RunOptions): Promise<RunResult> {
  // Argument validation must surface as a rejection, not a synchronous throw:
  // callers await this, and a sync throw skips their error handling path.
  let rawArgs: string[];
  try {
    rawArgs = buildArgs(opts);
  } catch (err) {
    return Promise.reject(err);
  }

  const isWindows = process.platform === "win32";
  const started = Date.now();

  const file = isWindows ? process.env.ComSpec || path.join(systemDir(), "cmd.exe") : config.codexBin;
  const commandLine = [config.codexBin, ...rawArgs].map(quoteForShell).join(" ");
  // /d skips AutoRun scripts, /c runs and exits. The outer quotes matter: with
  // /s cmd strips the first and last quote of the line, so an unwrapped line
  // whose first argument is quoted loses the closing quote of a *different* one.
  const args = isWindows ? ["/d", "/s", "/c", `"${commandLine}"`] : rawArgs;
  const command = isWindows ? commandLine : `${config.codexBin} ${rawArgs.join(" ")}`;

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      // Deliberately NOT the task workspace: on Windows the executable lookup
      // includes the working directory, and Codex can write to its workspace.
      // Codex gets its own working directory from --cd instead.
      cwd: config.root,
      windowsVerbatimArguments: isWindows,
      detached: !isWindows,
      windowsHide: true,
      env: childEnv(),
    });

    const stdout = new BoundedBuffer(config.maxOutputChars);
    const stderr = new BoundedBuffer(config.maxOutputChars);
    let timedOut = false;
    let settled = false;
    let reaper: NodeJS.Timeout | undefined;

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (reaper) clearTimeout(reaper);
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - started,
        command,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
      // A detached grandchild can hold the pipes open, so "close" may never
      // arrive. Settle anyway shortly after the kill rather than hanging.
      reaper = setTimeout(() => finish(null, "SIGKILL"), 5_000);
      reaper.unref();
    }, opts.timeoutSec * 1000);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (reaper) clearTimeout(reaper);
      if (err.code === "ENOENT") {
        reject(new CodexNotFoundError(config.codexBin));
        return;
      }
      err.message = `codex failed to launch (${err.code ?? "unknown"}): ${err.message}`;
      reject(err);
    });

    child.on("close", (code, signal) => finish(code, signal));

    child.stdin.on("error", () => {
      // Codex exited before reading the prompt; the close handler reports it.
    });
    child.stdin.end(opts.prompt, "utf8");
  });
}

/** Keep the head and tail of long output; the middle is where build noise lives. */
export function capOutput(text: string, max = config.maxOutputChars): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const dropped = text.length - max;
  return `${text.slice(0, half)}\n\n...[${dropped} characters omitted]...\n\n${text.slice(-half)}`;
}
