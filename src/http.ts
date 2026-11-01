import express from "express";
import { rateLimit } from "express-rate-limit";
import fs from "node:fs/promises";
import { createServer as createHttpServer, type RequestListener } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { OwnerOAuthProvider, MCP_SCOPE } from "./oauth.js";
import { createServer } from "./server.js";
import { config } from "./config.js";
import { validateCodexLogin } from "./codex.js";
import { startQuickTunnel, type Tunnel } from "./tunnel.js";
import { setupOwnerLogin } from "./login-setup.js";

export type HttpOptions = { publicUrl: URL; username: string; password: string; host: string; port: number };

export function httpOptions(env: NodeJS.ProcessEnv = process.env): HttpOptions {
  const publicUrl = new URL(env.CODEX_MCP_PUBLIC_URL || "http://127.0.0.1:3000");
  const port = Number(env.CODEX_MCP_PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid CODEX_MCP_PORT.");
  return {
    publicUrl, port, host: env.CODEX_MCP_HOST || "127.0.0.1",
    username: env.CODEX_MCP_USERNAME || "admin", password: env.CODEX_MCP_PASSWORD || "",
  };
}

/** One trusted owner, shared jobs and workspace root, with fresh transports per request. */
export function createHttpApp(options: HttpOptions, checkLogin = validateCodexLogin) {
  const { publicUrl } = options;
  const loopback = ["localhost", "127.0.0.1"].includes(publicUrl.hostname);
  if ((publicUrl.protocol !== "https:" && !(publicUrl.protocol === "http:" && loopback)) ||
      publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) {
    throw new Error("CODEX_MCP_PUBLIC_URL must be an HTTPS origin, or loopback HTTP for local tests.");
  }
  const resource = new URL("/mcp", publicUrl);
  const provider = new OwnerOAuthProvider(resource, options.username, options.password);
  const app = createMcpExpressApp({ host: options.host, allowedHosts: [publicUrl.hostname, "localhost", "127.0.0.1", "[::1]"] });
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
    next();
  });
  // This single-owner service intentionally counts the proxy address. Forwarded IPs are not trusted.
  const proxyRateLimit = { validate: { xForwardedForHeader: false } };
  app.use(mcpAuthRouter({ provider, issuerUrl: publicUrl, resourceServerUrl: resource,
    scopesSupported: [MCP_SCOPE], resourceName: "Codex local MCP",
    authorizationOptions: { rateLimit: proxyRateLimit }, clientRegistrationOptions: { rateLimit: proxyRateLimit },
    tokenOptions: { rateLimit: proxyRateLimit }, revocationOptions: { rateLimit: proxyRateLimit },
  }));
  // Also publish origin-level discovery for clients that do not probe the resource path.
  app.get("/.well-known/oauth-protected-resource", (_req, res) => res.json({
    resource: resource.href, authorization_servers: [publicUrl.href], scopes_supported: [MCP_SCOPE],
  }));
  app.post("/login", rateLimit({ windowMs: 900_000, limit: 10, standardHeaders: true, legacyHeaders: false, ...proxyRateLimit }),
    express.urlencoded({ extended: false, limit: "4kb", parameterLimit: 4 }), (req, res, next) => {
      provider.login(req, res).catch(next);
    });
  app.use("/mcp", (req, res, next) => {
    if (req.headers.origin && req.headers.origin !== publicUrl.origin) {
      res.status(403).json({ error: "Untrusted origin." }); return;
    }
    next();
  }, requireBearerAuth({ verifier: provider, requiredScopes: [MCP_SCOPE], expectedResource: resource,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource) }));

  let validUntil = 0;
  let checking: Promise<void> | undefined;
  app.post("/mcp", async (req, res, next) => {
    try {
      if (Date.now() >= validUntil) {
        checking ??= checkLogin().then(() => { validUntil = Date.now() + 30_000; }).finally(() => { checking = undefined; });
        try { await checking; } catch {
          res.status(503).json({ error: "Codex login is unavailable. Run codex login on the server." }); return;
        }
      }
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void server.close().catch(error => console.error("MCP close failed:", error)); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) { next(error); }
  });
  app.all("/mcp", (_req, res) => { res.setHeader("Allow", "POST"); res.status(405).end(); });
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (!res.headersSent) res.status(500).json({ error: "Request failed." });
  });
  return app;
}

export async function startHttpServer(activation: { tunnel?: boolean; setupLogin?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  if (activation.signal?.aborted) return;
  let options = httpOptions();
  if (activation.tunnel && !["127.0.0.1", "localhost"].includes(options.host)) {
    throw new Error("Built-in Cloudflare Tunnel requires CODEX_MCP_HOST=127.0.0.1 or localhost.");
  }
  // The connector always targets IPv4 loopback, regardless of localhost DNS order.
  if (activation.tunnel) options.host = "127.0.0.1";
  if (activation.setupLogin) options = await setupOwnerLogin(options);
  // Validate all remote configuration before spawning a helper or opening a port.
  const app = createHttpApp(options);
  await fs.mkdir(config.root, { recursive: true });
  await validateCodexLogin();
  if (activation.signal?.aborted) return;
  let handler: RequestListener = activation.tunnel
    ? (_req, res) => { res.writeHead(503); res.end("Tunnel activation in progress."); }
    : app;
  const listener = createHttpServer((req, res) => handler(req, res));
  let tunnel: Tunnel | undefined;
  const activationController = new AbortController();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    activationController.abort();
    listener.close();
    listener.closeAllConnections();
    await tunnel?.stop();
  };
  const onSignal = () => { void stop(); };
  activation.signal?.addEventListener("abort", onSignal, { once: true });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, onSignal);
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once("listening", resolve); listener.once("error", reject);
      listener.listen(options.port, options.host);
    });
    if (activation.tunnel) {
      console.error("Activating Cloudflare Tunnel...");
      const named = process.env.CODEX_MCP_TUNNEL === "named";
      tunnel = await startQuickTunnel({ port: options.port, signal: activationController.signal,
        ...(named ? { mode: "named", token: process.env.CODEX_MCP_TUNNEL_TOKEN, publicUrl: options.publicUrl } : {}) });
      if (stopped) { await tunnel.stop(); return; }
      options.publicUrl = tunnel.publicUrl;
      handler = createHttpApp(options);
      void tunnel.closed.then(async () => {
        if (!stopped) {
          console.error("Cloudflare Tunnel stopped. Remote access is unavailable.");
          process.exitCode = 1;
          await stop();
        }
      });
    }
    console.error(`codex-local-mcp ready: ${new URL("/mcp", options.publicUrl)} (OAuth login required)`);
    if (activation.tunnel) console.error(`claude mcp add --transport http codex-remote ${new URL("/mcp", options.publicUrl)}`);
    await new Promise<void>(resolve => listener.once("close", resolve));
  } finally {
    await stop();
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.off(signal, onSignal);
    activation.signal?.removeEventListener("abort", onSignal);
  }
}
