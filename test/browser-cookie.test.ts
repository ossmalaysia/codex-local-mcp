import { it, expect } from "vitest";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { installFakeCodex, makeRoot } from "./setup-fake-codex.mjs";

process.env.CODEX_BIN = installFakeCodex();
process.env.CODEX_MCP_ROOT = makeRoot();

it.skipIf(process.platform !== "win32")("stores the OAuth cookie automatically and retries a typing error in Windows", async () => {
  const { createHttpApp } = await import("../src/http.js");
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on("request", createHttpApp({ publicUrl: new URL(base), host: "127.0.0.1", port: 3000, username: "admin", password: "browser-cookie-test-password-only" }, async () => {}));
  try {
    const result = await promisify(execFile)("powershell.exe", ["-NoProfile", "-File", "scripts/test-oauth-browser.ps1", "-BaseUri", base], { timeout: 20000, windowsHide: true });
    expect(result.stdout).toContain("PKCE token exchange passed");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 25000);
