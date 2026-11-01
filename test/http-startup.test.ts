import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { installFakeCodex, makeRoot } from "./setup-fake-codex.mjs";

const connector = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("../src/tunnel.js", () => ({ startQuickTunnel: connector.start }));
process.env.CODEX_BIN = installFakeCodex();
process.env.CODEX_MCP_ROOT = makeRoot();
const { startHttpServer } = await import("../src/http.js");
const { setupOwnerLogin } = await import("../src/login-setup.js");

async function options() {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  vi.stubEnv("CODEX_MCP_PORT", String(port));
  vi.stubEnv("CODEX_MCP_HOST", "127.0.0.1");
  vi.stubEnv("CODEX_MCP_PASSWORD", "a-private-password-with-at-least-24-characters");
  vi.stubEnv("CODEX_MCP_PUBLIC_URL", `http://127.0.0.1:${port}`);
  return port;
}
afterEach(() => { vi.unstubAllEnvs(); connector.start.mockReset(); });

describe("tunnel activation lifecycle", () => {
  it("uses the generated OAuth origin and stops the connector on shutdown", async () => {
    const port = await options();
    let close!: () => void;
    const closed = new Promise<void>(resolve => { close = resolve; });
    const stop = vi.fn(async () => close());
    connector.start.mockResolvedValue({ publicUrl: new URL("https://test-blue-fox.trycloudflare.com"), closed, stop });
    const oldSignals = process.listeners("SIGTERM");
    const running = startHttpServer({ tunnel: true });
    // Attach immediately so startup errors cannot become unhandled rejections.
    const outcome = running.then(() => undefined, error => error);
    try {
      await vi.waitFor(async () => {
        const response = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`);
        expect((await response.json()).resource).toBe("https://test-blue-fox.trycloudflare.com/mcp");
      }, { timeout: 10_000 });
      expect(connector.start).toHaveBeenCalledWith(expect.objectContaining({ port }));
      expect((await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST" })).status).toBe(401);
    } finally {
      const signal = process.listeners("SIGTERM").find(listener => !oldSignals.includes(listener));
      signal?.();
      expect(await outcome).toBeUndefined();
    }
    expect(stop).toHaveBeenCalledTimes(1);
    expect(process.listeners("SIGTERM")).toEqual(oldSignals);
  }, 15_000);

  it("closes the listener when activation fails", async () => {
    const port = await options();
    const signals = process.listeners("SIGTERM");
    connector.start.mockRejectedValue(new Error("Connector unavailable"));
    await expect(startHttpServer({ tunnel: true })).rejects.toThrow("Connector unavailable");
    await expect(fetch(`http://127.0.0.1:${port}/mcp`)).rejects.toThrow();
    expect(process.listeners("SIGTERM")).toEqual(signals);
  }, 15_000);

  it("rejects a public bind address before starting the connector", async () => {
    await options();
    vi.stubEnv("CODEX_MCP_HOST", "0.0.0.0");
    await expect(startHttpServer({ tunnel: true })).rejects.toThrow("HOST");
    expect(connector.start).not.toHaveBeenCalled();
  });

  it("uses existing credentials without a prompt and requires credentials in unattended mode", async () => {
    const credentials = { username: "owner", password: "private existing password" };
    expect(await setupOwnerLogin(credentials)).toBe(credentials);
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      await expect(setupOwnerLogin({ username: "admin", password: "" })).rejects.toThrow("interactive terminal");
    }
  });
});
