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
  if (model) args.push("--model", model);
  // Trailing "-" makes codex read the prompt from stdin, so no shell quoting of
  // untrusted prompt text is ever needed.
  args.push("-");
  return args;
}

/** Windows spawn cannot kill a process tree, and codex spawns node/python children. */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
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
}

/**
 * With shell:true, Node hands the command line to cmd.exe verbatim, so any path
 * containing a space (C:\Users\First Last\...) silently splits into two args.
 * Quote everything ourselves. The prompt travels on stdin and is never quoted.
 */
function quoteForShell(value: string): string {
  if (value !== "" && !/[\s"^&|<>()%!]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * MCP clients launch servers with a minimal environment. `shell: true` would
 * leave Node to find cmd.exe through that environment and fail with ENOENT, so
 * resolve the interpreter absolutely instead.
 */
function windowsShell(): string {
  return (
    process.env.ComSpec ||
    path.join(process.env.SystemRoot || "C:\Windows", "System32", "cmd.exe")
  );
}

/**
 * codex.cmd re-invokes node, so the child needs a PATH that can find it even
 * when the launching client supplied none.
 */
function childEnv(): NodeJS.ProcessEnv {
  const extra = [path.dirname(config.codexBin), path.dirname(process.execPath)];
  if (process.platform === "win32") {
    extra.push(path.join(process.env.SystemRoot || "C:\Windows", "System32"));
  }
  const current = process.env.PATH || process.env.Path || "";
  const merged = [...extra, ...current.split(path.delimiter)]
    .filter((entry, index, all) => entry && all.indexOf(entry) === index)
    .join(path.delimiter);
  return { ...process.env, PATH: merged, Path: merged };
}

export function runCodex(opts: RunOptions): Promise<RunResult> {
  const rawArgs = buildArgs(opts);
  const isWindows = process.platform === "win32";
  const started = Date.now();

  const file = isWindows ? windowsShell() : config.codexBin;
  const commandLine = [config.codexBin, ...rawArgs].map(quoteForShell).join(" ");
  // /d skips AutoRun scripts, /c runs and exits. The outer quotes matter: with
  // /s cmd strips the first and last quote of the line, so an unwrapped line
  // whose first arg is quoted loses the closing quote of a *different* argument.
  const args = isWindows ? ["/d", "/s", "/c", `"${commandLine}"`] : rawArgs;
  const command = isWindows ? commandLine : `${config.codexBin} ${rawArgs.join(" ")}`;

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      windowsVerbatimArguments: isWindows,
      detached: !isWindows,
      windowsHide: true,
      env: childEnv(),
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, opts.timeoutSec * 1000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new CodexNotFoundError(config.codexBin));
        return;
      }
      err.message = `codex failed to launch (${err.code ?? "unknown"}): ${err.message}`;
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code,
        timedOut,
        durationMs: Date.now() - started,
        command,
      });
    });

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
