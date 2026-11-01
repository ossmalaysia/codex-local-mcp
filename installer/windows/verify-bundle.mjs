import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createServer as createListener } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './app/dist/server.js';
import { createHttpApp } from './app/dist/http.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
const load = createRequire(import.meta.url);
const sharp = load('./app/node_modules/sharp');
const pixels = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#4d46d7' } }).png().toBuffer();
if ((await sharp(pixels).metadata()).width !== 2) throw new Error('Bundled native image processing failed.');
const manifest = JSON.parse(fs.readFileSync(new URL('./release-manifest.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
if (manifest.service === 'rust') {
  const native = new Client({ name: 'native-bundle-verification', version: '1' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-bundle-'));
  try {
    await native.connect(new StdioClientTransport({
      command: fileURLToPath(new URL('./runtime/codex-mcp-service.exe', import.meta.url)),
      env: { ...process.env, CODEX_BIN: fileURLToPath(new URL('./runtime/codex/codex.exe', import.meta.url)), CODEX_MCP_ROOT: root, CODEX_MCP_TRANSPORT: 'stdio', CODEX_SANDBOX_MODE: 'workspace-write' },
    }));
    if (native.getServerVersion()?.version !== manifest.version || (await native.listTools()).tools.length !== 4) throw new Error('Installed Rust service contract or version failed.');
    console.log(`Installed Rust service and version verified: ${manifest.version}. No AI model was called.`);
  } finally { await native.close(); fs.rmdirSync(root); }
}
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createServer();
const client = new Client({ name: 'desktop-bundle-verification', version: '1' });
try {
  await server.connect(serverTransport); await client.connect(clientTransport);
  if (client.getServerVersion()?.version !== manifest.version) throw new Error('Bundled MCP version does not match its release.');
  const tools = await client.listTools();
  if (!tools.tools.some(tool => tool.name === 'codex_run')) throw new Error('Bundled server is missing Codex tools.');
  console.log(`Bundled MCP protocol and release version verified: ${manifest.version}.`);
} finally { await client.close(); await server.close(); }

const listener = createListener();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${listener.address().port}`;
const password = 'bundle-verification-password-only-32';
listener.on('request', createHttpApp({ publicUrl: new URL(base), host: '127.0.0.1', port: listener.address().port, username: 'admin', password }, async () => {}));
const form = (body, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body), redirect: 'manual' });
const remote = new Client({ name: 'desktop-http-bundle-check', version: '1' });
try {
  if ((await fetch(`${base}/mcp`, { method: 'POST' })).status !== 401) throw new Error('Bundled HTTP server accepted anonymous access.');
  const registration = await fetch(`${base}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Bundle verifier', redirect_uris: ['http://127.0.0.1:54321/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  if (registration.status !== 201) throw new Error('Bundled OAuth client registration failed.');
  const { client_id } = await registration.json(); const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ client_id, redirect_uri: 'http://127.0.0.1:54321/callback', response_type: 'code', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'codex:access', resource: `${base}/mcp`, state: 'bundle-check' });
  const authorization = await fetch(`${base}/authorize?${query}`, { redirect: 'manual' });
  const html = await authorization.text(); const request_id = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
  if (!request_id) throw new Error('Bundled OAuth login page failed.');
  const login = await fetch(`${base}/login`, form({ request_id, username: 'admin', password }, { Cookie: authorization.headers.get('set-cookie').split(';')[0], Origin: base }));
  if (login.status !== 303) throw new Error('Bundled OAuth browser login failed.');
  const code = new URL(login.headers.get('location')).searchParams.get('code');
  const exchange = await fetch(`${base}/token`, form({ client_id, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: 'http://127.0.0.1:54321/callback', resource: `${base}/mcp` }));
  if (exchange.status !== 200) throw new Error('Bundled OAuth PKCE exchange failed.');
  const token = await exchange.json();
  await remote.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } } }));
  if (remote.getServerVersion()?.version !== manifest.version || !(await remote.listTools()).tools.some(tool => tool.name === 'codex_run')) throw new Error('Bundled authenticated HTTP MCP failed.');
  console.log('Bundled native images, HTTP OAuth login, PKCE, anonymous rejection, and authenticated MCP verified. No AI model was called.');
} finally {
  await remote.close(); listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve));
}
