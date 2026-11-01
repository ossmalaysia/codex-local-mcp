import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { sandboxArguments } from "./sandbox.js";
import { BoundedBuffer, killTree } from "./codex.js";

async function main() {
  if (config.sandboxMode !== "isolated") throw new Error("Sandbox verification requires CODEX_SANDBOX_MODE=isolated.");
  if (!path.isAbsolute(config.codexBin) || (process.platform === "win32" && !config.codexBin.endsWith(".exe"))) {
    throw new Error("Sandbox verification requires the native Codex executable.");
  }
  await fs.mkdir(config.root, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(config.root, ".isolation-check-"));
  const privateRoot = config.privateRoot || os.tmpdir();
  await fs.mkdir(privateRoot, { recursive: true });
  const secret = path.join(privateRoot, `codex-mcp-probe-${randomUUID()}.txt`);
  const outsideWrite = `${secret}.write`;
  await fs.writeFile(secret, randomUUID(), { mode: 0o600 });
  // Also test default-denied host access, separately from the explicit private-directory rule.
  const outsideDirectory = await fs.mkdtemp(path.join(os.homedir(), ".codex-mcp-isolation-check-"));
  const outsideSecret = path.join(outsideDirectory, "sentinel.txt");
  await fs.writeFile(outsideSecret, randomUUID(), { mode: 0o600 });
  const listener = net.createServer(socket => socket.end());
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  try {
    const port = (listener.address() as net.AddressInfo).port;
    const args = [...sandboxArguments("isolated", config.windowsSandbox, config.networkAccess, process.platform, config.runtimeRoot, config.privateRoot),
      "sandbox", "--include-managed-config", "--permission-profile", "codex_mcp_isolated", "--cd", workspace, "--",
      process.execPath, "--preserve-symlinks", "--preserve-symlinks-main", fileURLToPath(new URL("./sandbox-check-child.js", import.meta.url)), secret, outsideWrite, String(port), String(config.networkAccess), outsideSecret];
    const output = new BoundedBuffer(6000);
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(config.codexBin, args, { cwd: config.runtimeRoot || path.dirname(config.codexBin), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => { if (child.pid) killTree(child.pid); reject(new Error("Sandbox verification timed out.")); }, 30_000);
      child.stdout.on("data", data => output.push(data.toString()));
      child.stderr.on("data", data => output.push(data.toString()));
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", exit => { clearTimeout(timer); resolve(exit); });
    });
    console.log(output.toString());
    if (code !== 0 || !output.toString().includes('"passed":true')) {
      throw new Error("Sandbox verification failed. Remote startup is blocked. Check the Windows backend and permissions.");
    }
  } finally {
    await new Promise<void>(resolve => listener.close(() => resolve()));
    for (const file of [secret, outsideWrite, outsideSecret, path.join(workspace, "inside.txt")]) await fs.unlink(file).catch(() => {});
    await fs.rmdir(outsideDirectory).catch(() => {});
    await fs.rmdir(workspace).catch(() => {});
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
