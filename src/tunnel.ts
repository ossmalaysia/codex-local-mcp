import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type TunnelOptions = { port: number; bin?: string; timeoutMs?: number; signal?: AbortSignal };
export type Tunnel = { publicUrl: URL; closed: Promise<void>; stop(): Promise<void> };
type SpawnTunnel = (bin: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;

/** Never resolve the connector from a task workspace or invoke it through a shell. */
export function resolveCloudflared(raw = process.env.CLOUDFLARED_BIN): string {
  const executable = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  if (raw && !path.isAbsolute(raw)) throw new Error("CLOUDFLARED_BIN must be an absolute executable path.");
  const candidates = raw ? [raw] : (process.env.PATH || "").split(path.delimiter)
    .filter(dir => path.isAbsolute(dir)).map(dir => path.join(dir, executable));
  if (!raw && process.platform === "win32") {
    for (const dir of [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]) {
      if (dir) candidates.push(path.join(dir, "cloudflared", executable));
    }
  }
  for (const candidate of candidates) {
    try {
      if (process.platform === "win32" && !candidate.toLowerCase().endsWith(".exe")) continue;
      fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* Try the next trusted directory. */ }
  }
  throw new Error("Install cloudflared or set CLOUDFLARED_BIN to its absolute executable path.");
}

/** The connector needs network and OS settings, but does not need application credentials. */
export function tunnelEnv(env = process.env): NodeJS.ProcessEnv {
  const allowed = /^(PATH|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|SYSTEMDRIVE|XDG_CONFIG_HOME)$/i;
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.test(key)));
}

/** Only accept a complete HTTPS origin from the connector's generated URL announcement. */
export function quickTunnelUrl(log: string): URL | undefined {
  const match = /https:\/\/([a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com)(?=[\s|"']|$)/i.exec(log);
  return match ? new URL(`https://${match[1].toLowerCase()}`) : undefined;
}

export async function startQuickTunnel(
  options: TunnelOptions,
  launch: SpawnTunnel = (bin, args, env) => spawn(bin, args, {
    env, cwd: path.dirname(bin), windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
  }),
): Promise<Tunnel> {
  const bin = resolveCloudflared(options.bin);
  if (options.signal?.aborted) throw new Error("Tunnel activation cancelled.");
  // An explicit empty configuration prevents an existing named tunnel from changing the destination.
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-mcp-tunnel-"));
  const configFile = path.join(directory, "config.yml");
  const removeConfig = async () => {
    await fsp.unlink(configFile).catch(() => {});
    await fsp.rmdir(directory).catch(() => {});
  };
  let child: ChildProcess;
  try {
    await fsp.writeFile(configFile, "{}\n", { mode: 0o600 });
    const args = ["tunnel", "--config", configFile, "--no-autoupdate", "--url", `http://127.0.0.1:${options.port}`];
    child = launch(bin, args, tunnelEnv());
  } catch (error) { await removeConfig(); throw error; }
  let stopping = false;
  let closed = false;
  let finishClosed!: () => void;
  const completion = new Promise<void>(resolve => { finishClosed = resolve; });
  child.once("close", () => { closed = true; void removeConfig().finally(finishClosed); });
  // A failed spawn can emit error without a useful exit status.
  child.once("error", () => { closed = true; void removeConfig().finally(finishClosed); });
  const stop = async () => {
    if (closed) return;
    stopping = true;
    child.kill("SIGTERM");
    const force = setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 2000);
    force.unref();
    try { await completion; } finally { clearTimeout(force); }
  };
  try {
    const publicUrl = await new Promise<URL>((resolve, reject) => {
      let buffer = "";
      let url: URL | undefined;
      let connected = false;
      const timer = setTimeout(() => fail("Cloudflare Tunnel activation timed out. Check outbound network access."), options.timeoutMs ?? 45_000);
      const onAbort = () => fail("Tunnel activation cancelled.");
      const cleanup = () => {
        clearTimeout(timer); child.off("error", onError); child.off("close", onClose);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const fail = (message: string) => { cleanup(); reject(new Error(message)); };
      const onError = () => fail("Could not start cloudflared. Check CLOUDFLARED_BIN.");
      const onClose = () => fail("cloudflared stopped before activation. Check its installation and network access.");
      child.once("error", onError);
      child.once("close", onClose);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      const read = (chunk: Buffer) => {
        // Continue draining both streams after activation, without retaining unbounded logs.
        buffer = (buffer + chunk.toString("utf8")).slice(-16_384);
        url ??= quickTunnelUrl(buffer);
        connected ||= buffer.includes("Registered tunnel connection");
        if (url && connected) { cleanup(); resolve(url); }
      };
      child.stdout?.on("data", read);
      child.stderr?.on("data", read);
    });
    // Keep an error listener after startup; connector failure must not crash Node.
    child.on("error", () => { if (!stopping) console.error("Cloudflare Tunnel process failed."); });
    return { publicUrl, closed: completion, stop };
  } catch (error) { await stop(); throw error; }
}
