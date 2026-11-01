import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { quickTunnelUrl, resolveCloudflared, startQuickTunnel, tunnelEnv } from "../src/tunnel.js";

function connector() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { queueMicrotask(() => child.emit("close", 0)); return true; }),
  });
  return child;
}

describe("built-in Cloudflare Tunnel", () => {
  it("accepts only a generated HTTPS origin", () => {
    expect(quickTunnelUrl(" | https://calm-blue-fox.trycloudflare.com | ")?.href).toBe("https://calm-blue-fox.trycloudflare.com/");
    for (const text of ["http://calm-blue-fox.trycloudflare.com", "https://calm.trycloudflare.com.attacker.example", "https://calm.trycloudflare.com/path"]) {
      expect(quickTunnelUrl(text)).toBeUndefined();
    }
  });

  it("excludes application credentials and tunnel configuration from the connector environment", () => {
    expect(tunnelEnv({ PATH: "/bin", HTTPS_PROXY: "http://proxy", CODEX_MCP_PASSWORD: "secret", OPENAI_API_KEY: "secret",
      TUNNEL_TOKEN: "secret", TUNNEL_URL: "http://other", TUNNEL_ORIGIN_CERT: "private.pem" })).toEqual({ PATH: "/bin", HTTPS_PROXY: "http://proxy" });
    expect(() => resolveCloudflared("relative/cloudflared")).toThrow("absolute");
  });

  it("waits for both the URL and a connection, drains logs, and removes its temporary config", async () => {
    const child = connector();
    let configFile = "";
    const launch = vi.fn((_bin: string, args: string[]) => {
      configFile = args[args.indexOf("--config") + 1];
      expect(fs.readFileSync(configFile, "utf8")).toBe("{}\n");
      expect(args).toContain("http://127.0.0.1:3210");
      setImmediate(() => {
        child.stderr.write(" | https://calm-blue-");
        child.stderr.write("fox.trycloudflare.com |\n");
        child.stderr.write("INF Registered tunnel connection connIndex=0\n");
      });
      return child as unknown as ChildProcess;
    });
    const tunnel = await startQuickTunnel({ port: 3210, bin: process.execPath }, launch);
    expect(tunnel.publicUrl.href).toBe("https://calm-blue-fox.trycloudflare.com/");
    child.stderr.write("x".repeat(50_000));
    await tunnel.stop();
    await tunnel.closed;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(fs.existsSync(configFile)).toBe(false);
  });

  it("stops the connector when activation times out", async () => {
    const child = connector();
    await expect(startQuickTunnel({ port: 3210, bin: process.execPath, timeoutMs: 20 }, () => child as unknown as ChildProcess)).rejects.toThrow("timed out");
    expect(child.kill).toHaveBeenCalled();
  });

  it("handles launch errors, early exits, and cancellation", async () => {
    for (const event of ["error", "close"]) {
      const child = connector();
      await expect(startQuickTunnel({ port: 3210, bin: process.execPath }, () => {
        setImmediate(() => child.emit(event, event === "error" ? new Error("private details") : 1));
        return child as unknown as ChildProcess;
      })).rejects.toThrow(event === "error" ? "Could not start" : "stopped before");
    }
    const controller = new AbortController();
    const child = connector();
    await expect(startQuickTunnel({ port: 3210, bin: process.execPath, signal: controller.signal }, () => {
      setImmediate(() => controller.abort());
      return child as unknown as ChildProcess;
    })).rejects.toThrow("cancelled");
    expect(child.kill).toHaveBeenCalled();
  });
});
