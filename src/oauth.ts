import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTokenError, InvalidRequestError, InvalidScopeError, TooManyRequestsError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { sendLoginPage } from "./login-page.js";

const random = () => randomBytes(32).toString("base64url");
const seconds = () => Math.floor(Date.now() / 1000);
export const MCP_SCOPE = "codex:access";

/** Expiry and a hard cap keep unauthenticated registration and login flows bounded. */
class ExpiringStore<T> {
  private entries = new Map<string, { value: T; expires: number }>();
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.expires <= seconds()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }
  set(key: string, value: T, ttl: number): void {
    for (const [id, entry] of this.entries) if (entry.expires <= seconds()) this.entries.delete(id);
    if (this.entries.size >= 4000) throw new TooManyRequestsError("Authorization storage is full. Try again later.");
    this.entries.set(key, { value, expires: seconds() + ttl });
  }
  delete(key: string): void { this.entries.delete(key); }
}

type Grant = { clientId: string; params: AuthorizationParams };
type Pending = Grant & { browser: string; clientName: string };
type Family = { clientId: string; expiresAt: number; revoked: boolean };
type Token = { family: Family; expiresAt: number; used?: boolean };

/** A single-owner OAuth provider. OpenAI credentials never enter this protocol. */
export class OwnerOAuthProvider implements OAuthServerProvider {
  private clients = new ExpiringStore<OAuthClientInformationFull>();
  private pending = new ExpiringStore<Pending>();
  private codes = new ExpiringStore<Grant>();
  private access = new ExpiringStore<Token>();
  private refresh = new ExpiringStore<Token>();
  private salt = randomBytes(32);
  private passwordHash: Buffer;

  constructor(private resource: URL, private username: string, password: string) {
    if (!username || password.length < 24 || Buffer.byteLength(password) > 1024) {
      throw new Error("Set CODEX_MCP_PASSWORD to 24–1024 bytes and CODEX_MCP_USERNAME to a nonempty name.");
    }
    this.passwordHash = scryptSync(password, this.salt, 64);
  }

  clientsStore = {
    getClient: (id: string) => this.clients.get(id),
    registerClient: async (client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) => {
      for (const redirect of client.redirect_uris) {
        const url = new URL(redirect);
        const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
        if (url.hash || url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && loopback))) {
          throw new InvalidRequestError("Redirect URIs must use HTTPS or loopback HTTP without fragments or credentials.");
        }
      }
      const registered = { ...client, client_id: random(), client_id_issued_at: seconds() };
      this.clients.set(registered.client_id, registered, 30 * 86400);
      return registered;
    },
  };

  private checkResource(resource?: URL): void {
    if (resource && resource.href !== this.resource.href) throw new InvalidRequestError("Invalid resource.");
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.checkResource(params.resource);
    if (params.scopes?.some(scope => scope !== MCP_SCOPE)) throw new InvalidScopeError("Invalid scope.");
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidRequestError("Invalid S256 challenge.");
    const id = random();
    const browser = random();
    this.pending.set(id, { clientId: client.client_id, params, browser, clientName: client.client_name || client.client_id }, 600);
    // Separate cookies prevent another connector tab from replacing this request's browser binding.
    res.cookie(`codex_oauth_${id}`, browser, {
      httpOnly: true, secure: this.resource.protocol === "https:", sameSite: "lax", path: "/", maxAge: 600_000,
    });
    sendLoginPage(res, { id, client: client.client_name || client.client_id, callback: params.redirectUri });
  }

  async login(req: Request, res: Response): Promise<void> {
    const id = typeof req.body?.request_id === "string" ? req.body.request_id : "";
    const pending = this.pending.get(id);
    const cookieName = `codex_oauth_${id}=`;
    const cookie = req.headers.cookie?.split(";").map(v => v.trim()).find(v => v.startsWith(cookieName))?.slice(cookieName.length);
    if (!pending || cookie !== pending.browser || (req.headers.origin && req.headers.origin !== this.resource.origin)) {
      console.error("MCP sign-in rejected: " + (!pending ? "request expired or server restarted." : cookie !== pending.browser ? "browser cookie missing or mismatched." : "untrusted browser origin."));
      sendLoginPage(res.status(400), { error: pending && cookie !== pending.browser ? "browser" : "expired" });
      return;
    }
    // Keep browser-bound requests available after a typing error. Rate limits still apply.
    const invalidCredentials = () => sendLoginPage(res.status(401), {
      id, client: pending.clientName, callback: pending.params.redirectUri,
      notice: "The MCP username or password did not match. Check the saved login in the app and try again.",
    });
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (Buffer.byteLength(password) > 1024) { invalidCredentials(); return; }
    const hash = await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, this.salt, 64, (error, result) => error ? reject(error) : resolve(result));
    });
    if (!timingSafeEqual(hash, this.passwordHash) || req.body.username !== this.username) {
      invalidCredentials();
      return;
    }
    // Concurrent valid submissions must not issue two authorization codes.
    if (this.pending.get(id) !== pending) { sendLoginPage(res.status(400), { error: "expired" }); return; }
    this.pending.delete(id);
    const code = random();
    this.codes.set(code, pending, 60);
    const callback = new URL(pending.params.redirectUri);
    callback.searchParams.set("code", code);
    if (pending.params.state !== undefined) callback.searchParams.set("state", pending.params.state);
    res.clearCookie(`codex_oauth_${id}`, { path: "/", secure: this.resource.protocol === "https:", sameSite: "lax", httpOnly: true });
    res.redirect(303, callback.href);
  }

  private code(client: OAuthClientInformationFull, code: string): Grant {
    const grant = this.codes.get(code);
    if (!grant || grant.clientId !== client.client_id) throw new InvalidGrantError("Invalid authorization code.");
    return grant;
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.code(client, code).params.codeChallenge;
  }
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const grant = this.code(client, code);
    this.checkResource(resource);
    if (redirectUri !== grant.params.redirectUri) throw new InvalidGrantError("Redirect URI does not match.");
    this.codes.delete(code);
    return this.issue({ clientId: client.client_id, expiresAt: seconds() + 86400, revoked: false });
  }
  private issue(family: Family): OAuthTokens {
    const access = random();
    const refresh = random();
    this.access.set(access, { family, expiresAt: seconds() + 900 }, 900);
    this.refresh.set(refresh, { family, expiresAt: family.expiresAt }, family.expiresAt - seconds());
    return { access_token: access, token_type: "Bearer", expires_in: 900, refresh_token: refresh, scope: MCP_SCOPE };
  }
  async exchangeRefreshToken(client: OAuthClientInformationFull, refresh: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    this.checkResource(resource);
    const token = this.refresh.get(refresh);
    if (!token || token.family.clientId !== client.client_id || token.family.revoked) throw new InvalidGrantError("Invalid refresh token.");
    if (token.used) {
      token.family.revoked = true;
      throw new InvalidGrantError("Refresh token reuse detected. Sign in again.");
    }
    if (scopes?.some(scope => scope !== MCP_SCOPE)) throw new InvalidScopeError("Invalid scope.");
    token.used = true;
    return this.issue(token.family);
  }
  async verifyAccessToken(access: string) {
    const token = this.access.get(access);
    if (!token || token.family.revoked || token.family.expiresAt <= seconds()) throw new InvalidTokenError("Invalid or expired access token.");
    return { token: access, clientId: token.family.clientId, scopes: [MCP_SCOPE], expiresAt: token.expiresAt, resource: this.resource };
  }
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const token = this.access.get(request.token) || this.refresh.get(request.token);
    if (token?.family.clientId === client.client_id) token.family.revoked = true;
  }
}
