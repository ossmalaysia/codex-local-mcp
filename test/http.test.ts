import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { installFakeCodex, makeRoot } from "./setup-fake-codex.mjs";

process.env.CODEX_BIN = installFakeCodex();
process.env.CODEX_MCP_ROOT = makeRoot();
const password = "private-test-password-with-32-characters";
const { createHttpApp, httpOptions } = await import("../src/http.js");
const { childEnv, validateCodexLogin } = await import("../src/codex.js");
let listener: Server;
let base: string;
let loginAvailable = true;
const checkLogin = vi.fn(async () => { if (!loginAvailable) throw new Error("Logged out"); });

beforeAll(async () => {
  // Reserve a port before creating the app, so metadata uses its actual origin.
  const { createServer } = await import("node:http");
  listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  listener.on("request", createHttpApp({ publicUrl: new URL(base), host: "127.0.0.1", port: 3000, username: "admin", password }, checkLogin));
});
afterAll(async () => {
  listener.closeAllConnections();
  await new Promise<void>(resolve => listener.close(() => resolve()));
});

const form = (body: Record<string, string>, headers = {}) => ({
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
  body: new URLSearchParams(body), redirect: "manual" as const,
});
async function register() {
  const response = await fetch(`${base}/register`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      client_name: "Test <client>", redirect_uris: ["http://127.0.0.1:54321/callback"],
      token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ client_id: string }>;
}
async function authorize(clientId: string, extra: Record<string, string> = {}) {
  const verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: "http://127.0.0.1:54321/callback",
    response_type: "code", code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256", scope: "codex:access", resource: `${base}/mcp`, state: "test-state", ...extra });
  const response = await fetch(`${base}/authorize?${params}`, { redirect: "manual" });
  const html = await response.text();
  return { response, html, verifier, id: /name="request_id" value="([^"]+)"/.exec(html)?.[1] || "",
    cookie: response.headers.get("set-cookie")?.split(";")[0] || "" };
}
async function approvedCode(clientId: string) {
  const auth = await authorize(clientId);
  expect(auth.response.status).toBe(200);
  expect(auth.html).toContain("Test &lt;client&gt;");
  const nonce = /<style nonce="([^"]+)">/.exec(auth.html)?.[1];
  expect(nonce).toBeTruthy();
  expect(auth.response.headers.get("content-security-policy")).toContain(`style-src 'nonce-${nonce}'`);
  expect(auth.response.headers.get("content-security-policy")).not.toContain("unsafe-inline");
  expect(auth.response.headers.get("referrer-policy")).toBe("same-origin");
  expect(auth.response.headers.get("content-security-policy")).toContain("form-action 'self' http://127.0.0.1:54321;");
  expect(auth.html).not.toContain("<script");
  expect(auth.html).toContain('autocomplete="current-password"');
  const response = await fetch(`${base}/login`, form({ request_id: auth.id, username: "admin", password }, { Cookie: auth.cookie, Origin: base }));
  expect(response.status).toBe(303);
  const callback = new URL(response.headers.get("location")!);
  expect(callback.searchParams.get("state")).toBe("test-state");
  return { code: callback.searchParams.get("code")!, verifier: auth.verifier };
}
const exchange = (clientId: string, code: string, verifier: string, extra = {}) => fetch(`${base}/token`, form({
  client_id: clientId, code, code_verifier: verifier, grant_type: "authorization_code",
  redirect_uri: "http://127.0.0.1:54321/callback", resource: `${base}/mcp`, ...extra,
}));

describe("remote MCP OAuth", () => {
  it("keeps two browser authorization pages valid in the same cookie jar", async () => {
    const { createServer } = await import("node:http");
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    server.on("request", createHttpApp({ publicUrl: new URL(origin), host: "127.0.0.1", port: 3000, username: "admin", password }, checkLogin));
    try {
      const client = await (await fetch(`${origin}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:54321/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }) })).json();
      const jar = new Map<string, string>();
      const pages: { id: string; verifier: string }[] = [];
      for (let i = 0; i < 2; i++) {
        const verifier = randomBytes(32).toString("base64url");
        const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: "http://127.0.0.1:54321/callback", response_type: "code", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", scope: "codex:access", resource: `${origin}/mcp` });
        const response = await fetch(`${origin}/authorize?${query}`, { headers: { Cookie: [...jar.values()].join("; ") } });
        const cookie = response.headers.get("set-cookie")!.split(";")[0];
        jar.set(cookie.split("=")[0], cookie);
        pages.push({ id: /name="request_id" value="([^"]+)"/.exec(await response.text())![1], verifier });
      }
      for (const page of pages) {
        const response = await fetch(`${origin}/login`, form({ request_id: page.id, username: "admin", password }, { Cookie: [...jar.values()].join("; "), Origin: origin }));
        expect(response.status).toBe(303);
        const code = new URL(response.headers.get("location")!).searchParams.get("code")!;
        const tokens = await fetch(`${origin}/token`, form({ client_id: client.client_id, code, code_verifier: page.verifier, grant_type: "authorization_code", redirect_uri: "http://127.0.0.1:54321/callback", resource: `${origin}/mcp` }));
        expect(tokens.status).toBe(200);
      }
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("rejects anonymous access and advertises discovery", async () => {
    const response = await fetch(`${base}/mcp`, { method: "POST" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(`${base}/.well-known/oauth-protected-resource/mcp`);
    const metadata = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(metadata.resource).toBe(`${base}/mcp`);
    const discovery = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(discovery.code_challenge_methods_supported).toEqual(["S256"]);
    expect(discovery.registration_endpoint).toBe(`${base}/register`);
    expect((await fetch(`${base}/mcp`, { headers: { Authorization: "Bearer invalid" } })).status).toBe(401);
  });

  it("rejects wrong login, missing browser binding, and cross-origin login", async () => {
    const client = await register();
    const auth = await authorize(client.client_id);
    const body = { request_id: auth.id, username: "admin", password };
    expect((await fetch(`${base}/login`, form(body))).status).toBe(400);
    expect((await fetch(`${base}/login`, form(body, { Cookie: auth.cookie, Origin: "https://attacker.example" }))).status).toBe(400);
    expect((await fetch(`${base}/login`, form({ ...body, password: "wrong" }, { Cookie: auth.cookie }))).status).toBe(401);
    expect((await fetch(`${base}/login`, form(body, { Cookie: auth.cookie }))).status).toBe(303);
  });

  it("rejects invalid redirects, resources, scopes, PKCE, and code replay", async () => {
    const client = await register();
    expect((await authorize(client.client_id, { redirect_uri: "https://attacker.example" })).response.status).toBe(400);
    for (const extra of [{ resource: "https://attacker.example/mcp" }, { scope: "admin" }, { code_challenge_method: "plain" }]) {
      const auth = await authorize(client.client_id, extra);
      expect(auth.response.status).toBe(302);
      expect(auth.response.headers.get("location")).toContain("error=");
    }
    const { code, verifier } = await approvedCode(client.client_id);
    expect((await exchange(client.client_id, code, "wrong")).status).toBe(400);
    expect((await exchange(client.client_id, code, verifier, { redirect_uri: "http://127.0.0.1:54321/other" })).status).toBe(400);
    expect((await exchange(client.client_id, code, verifier, { resource: "https://attacker.example/mcp" })).status).toBe(400);
    expect((await exchange(client.client_id, code, verifier)).status).toBe(200);
    expect((await exchange(client.client_id, code, verifier)).status).toBe(400);
  });

  it("connects a real MCP client, runs Codex, and revokes rotated tokens on replay", async () => {
    const registered = await register();
    const approved = await approvedCode(registered.client_id);
    const tokens = await (await exchange(registered.client_id, approved.code, approved.verifier)).json();
    const client = new Client({ name: "remote-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.some(tool => tool.name === "codex_run")).toBe(true);
      const result = await client.callTool({ name: "codex_run", arguments: { prompt: "remote test", workspace: "remote", wait_sec: 5 } });
      expect(result.isError).toBe(false);
      expect(JSON.stringify(result.content)).toContain("fake codex");
      const read = await client.callTool({ name: "codex_read_artifact", arguments: { path: "remote/notes.txt" } });
      expect(JSON.stringify(read.content)).toContain("remote test");
      expect(checkLogin).toHaveBeenCalledTimes(1);
    } finally { await client.close(); }
    expect((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${tokens.access_token}`, Origin: "https://attacker.example" } })).status).toBe(403);
    const refresh = () => fetch(`${base}/token`, form({ client_id: registered.client_id, grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource: `${base}/mcp` }));
    const rotatedResponse = await refresh();
    expect(rotatedResponse.status).toBe(200);
    const rotated = await rotatedResponse.json();
    expect((await refresh()).status).toBe(400);
    expect((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${rotated.access_token}` } })).status).toBe(401);
  });

  it("enforces client binding, token expiry, and revocation", async () => {
    const client = await register();
    const other = await register();
    const { code, verifier } = await approvedCode(client.client_id);
    expect((await exchange(other.client_id, code, verifier)).status).toBe(400);
    const tokens = await (await exchange(client.client_id, code, verifier)).json();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 901_000);
    try {
      expect((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401);
    } finally { clock.mockRestore(); }
    const refreshed = await (await fetch(`${base}/token`, form({ client_id: client.client_id, grant_type: "refresh_token", refresh_token: tokens.refresh_token }))).json();
    expect((await fetch(`${base}/revoke`, form({ client_id: client.client_id, token: refreshed.refresh_token }))).status).toBe(200);
    expect((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${refreshed.access_token}` } })).status).toBe(401);
  });

  it("blocks requests after Codex login becomes unavailable", async () => {
    const client = await register();
    const { code, verifier } = await approvedCode(client.client_id);
    const tokens = await (await exchange(client.client_id, code, verifier)).json();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    loginAvailable = false;
    try {
      expect((await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}` } })).status).toBe(503);
    } finally { clock.mockRestore(); loginAvailable = true; }
  });

  it("expires authorization codes and browser forms, then limits login attempts", async () => {
    const client = await register();
    const { code, verifier } = await approvedCode(client.client_id);
    let clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    try { expect((await exchange(client.client_id, code, verifier)).status).toBe(400); }
    finally { clock.mockRestore(); }
    const auth = await authorize(client.client_id);
    clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 601_000);
    try {
      expect((await fetch(`${base}/login`, form({ request_id: auth.id, username: "admin", password }, { Cookie: auth.cookie }))).status).toBe(400);
    } finally { clock.mockRestore(); }
    expect((await fetch(`${base}/login`, form({}))).status).toBe(429);
  });

  it("validates CLI login and excludes the remote password from subprocesses", async () => {
    process.env.CODEX_MCP_PASSWORD = password;
    expect(childEnv().CODEX_MCP_PASSWORD).toBeUndefined();
    delete process.env.CODEX_MCP_PASSWORD;
    await expect(validateCodexLogin()).resolves.toBeUndefined();
    process.env.FAKE_CODEX_LOGGED_OUT = "1";
    try { await expect(validateCodexLogin()).rejects.toThrow("not logged in"); }
    finally { delete process.env.FAKE_CODEX_LOGGED_OUT; }
  }, 15_000);

  it("refuses unsafe or incomplete remote configuration", () => {
    expect(() => httpOptions({ CODEX_MCP_PORT: "0" })).toThrow("PORT");
    for (const publicUrl of ["http://public.example", "https://example.com/prefix", "https://user:pass@example.com", "ftp://localhost"]) {
      expect(() => createHttpApp({ publicUrl: new URL(publicUrl), username: "admin", password, port: 3000, host: "127.0.0.1" })).toThrow("PUBLIC_URL");
    }
    expect(() => createHttpApp({ publicUrl: new URL(base), username: "admin", password: "", port: 3000, host: "127.0.0.1" })).toThrow("PASSWORD");
  });
});
