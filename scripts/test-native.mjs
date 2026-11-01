// Exercise the actual Rust executable with the TypeScript MCP client and Chromium.
// Only the separate native fixture executes. No AI model or live account is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chromium } from 'playwright';

const exe = process.platform === 'win32' ? '.exe' : '';
const binIndex = process.argv.indexOf('--service');
const bin = path.resolve(binIndex >= 0 ? process.argv[binIndex + 1] : `target/debug/codex-mcp-service${exe}`);
const fake = path.resolve(`target/debug/examples/fake_codex${exe}`);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-test-'));
const password = 'native-browser-test-password-only-€中';
const env = { ...process.env, CODEX_BIN: fake, CODEX_MCP_ROOT: root, CODEX_SANDBOX_MODE: 'workspace-write', CODEX_MCP_TRANSPORT: 'stdio', CODEX_MCP_ACTIVITY: '1', CODEX_MCP_PASSWORD: password, CODEX_MCP_TUNNEL_TOKEN: 'must-not-reach-child', CODEX_WAIT_SEC: '1', CODEX_MAX_RUNNING_JOBS: '2' };
const contract = JSON.parse(await fs.readFile(new URL('../native/service/contract.json', import.meta.url)));
// rmcp 3 removed the legacy execution.taskSupport hint. Names, schemas, and descriptions must match.
const nativeTools = contract.tools.map(({ execution, ...tool }) => tool);
const makeClient = () => new Client({ name: 'native-regression', version: '1' });
let server, browser;
const clients = [];
const callback = createServer();
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const tokens = [];
try {
  // stdio transport must remain free of logs and private telemetry.
  const stdio = new StdioClientTransport({ command: bin, env, stderr: 'pipe' });
  let activity = ''; stdio.stderr?.on('data', b => { activity += b.toString(); });
  const local = makeClient(); clients.push(local); await local.connect(stdio);
  assert.deepEqual((await local.listTools()).tools, nativeTools);
  assert.deepEqual((await local.listResourceTemplates()).resourceTemplates, contract.resourceTemplates);
  const result = await local.callTool({ name: 'codex_run', arguments: { prompt: 'FAKE_DELAY private-prompt-sentinel', workspace: 'job-one', wait_sec: 0 } });
  assert.match(result.content[0].text, /status: running/);
  const id = /job_id: ([\w-]+)/.exec(result.content[0].text)[1];
  const done = await local.callTool({ name: 'codex_job_result', arguments: { job_id: id, wait_sec: 5 } });
  assert.equal(done.isError, false); assert.match(done.content[0].text, /result.txt/);
  const read = await local.callTool({ name: 'codex_read_artifact', arguments: { path: 'job-one/result.txt' } });
  assert.equal(read.content[1].text, 'native fixture output');
  const resource = await local.readResource({ uri: pathToFileURL(path.join(root, 'job-one/result.txt')).href });
  assert.equal(resource.contents[0].text, 'native fixture output');
  for (const workspace of ['../escape', 'C:\\escape', '//server/share', 'x:stream']) {
    const denied = await local.callTool({ name: 'codex_run', arguments: { prompt: 'test', workspace } }); assert.equal(denied.isError, true);
  }
  const denied = await local.callTool({ name: 'codex_read_artifact', arguments: { path: '../outside.txt' } }); assert.equal(denied.isError, true);
  for (const args of [{ prompt: 3 }, { prompt: '' }, { prompt: 'test', workspace: 4 }, { prompt: 'test', count: -1 }, { prompt: 'test', count: 1.5 }, { prompt: 'test', open: 'false' }]) {
    const bad = await local.callTool({ name: 'codex_generate_image', arguments: args }); assert.equal(bad.isError, true);
  }
  const timed = await local.callTool({ name: 'codex_run', arguments: { prompt: 'FAKE_TIMEOUT', timeout_sec: 1, wait_sec: 5 } });
  assert.equal(timed.isError, true); assert.match(timed.content[0].text, /TIMED OUT/);
  const failed = await local.callTool({ name: 'codex_run', arguments: { prompt: 'FAKE_FAILURE', wait_sec: 5 } }); assert.equal(failed.isError, true);
  const image = await local.callTool({ name: 'codex_generate_image', arguments: { prompt: 'fixture image', open: false, wait_sec: 5 } });
  assert.equal(image.isError, false); assert.ok(image.content.some(c => c.type === 'image')); assert.ok(image.content.some(c => c.type === 'resource_link'));
  assert.match(activity, /running_command/); assert.match(activity, /writing_files/); assert.ok(!activity.includes('private-prompt-sentinel')); assert.ok(!activity.includes(password));
  await local.close();
  console.log('Native stdio passed: contract, detached jobs, polling, artifacts, images, path denial, timeout, failure, child secrets, and private activity.');

  // Reserve an unused local port. The child is managed and closes on stdin EOF.
  const reservation = createServer(); await listen(reservation); const port = reservation.address().port; await close(reservation);
  let origin = `http://127.0.0.1:${port}`;
  const liveTunnel = process.argv.includes('--tunnel');
  let logs = '';
  const managedEnv = { ...env, CODEX_MCP_PORT: String(port), CODEX_MCP_PUBLIC_URL: origin };
  delete managedEnv.CODEX_MCP_PASSWORD; delete managedEnv.CODEX_MCP_TUNNEL_TOKEN;
  server = spawn(bin, [liveTunnel ? '--tunnel' : '--http', '--managed', '--secrets-stdin'], { env: { ...managedEnv, CODEX_MCP_TUNNEL: 'quick' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  server.stdin.write(JSON.stringify({ password, tunnelToken: 'private-fixture-token' }) + '\n');
  server.stderr.on('data', b => { logs += b.toString(); });
  server.stdout.resume();
  for (let i = 0; i < (liveTunnel ? 1200 : 200); i++) {
    if (server.exitCode !== null) throw new Error(`Native server exited: ${logs}`);
    if (logs.includes('codex-local-mcp ready:')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.match(logs, /codex-local-mcp ready:/);
  if (liveTunnel) origin = new URL(/codex-local-mcp ready: (https:\/\/\S+) \(OAuth/.exec(logs)[1]).origin;
  if (liveTunnel) {
    let reachable = false;
    for (let i = 0; i < 30; i++) {
      try { reachable = (await fetch(`${origin}/.well-known/oauth-protected-resource`, { signal: AbortSignal.timeout(5000) })).status === 200; } catch {}
      if (reachable) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    assert.ok(reachable, 'Temporary Cloudflare hostname did not become reachable');
  }
  assert.equal((await fetch(`${origin}/mcp`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${origin}/.well-known/oauth-protected-resource`)).status, 200);
  assert.equal((await fetch(`${origin}/register`, { method: 'POST', headers: { Origin: 'null', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  await listen(callback);
  const callbackOrigin = `http://127.0.0.1:${callback.address().port}`;
  const redirect = `${callbackOrigin}/callback`;
  const register = await fetch(`${origin}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Browser regression <test>', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }) });
  assert.equal(register.status, 201); const { client_id } = await register.json();
  for (const badRedirect of ['https://example.test/cb#fragment', 'http://example.test/cb', 'https://user:password@example.test/cb', 'javascript:alert(1)']) {
    const response = await fetch(`${origin}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [badRedirect] }) });
    assert.equal(response.status, 400);
  }
  const verifier = randomBytes(32).toString('base64url');
  let callbackError; let passed = false;
  callback.on('request', async (req, res) => {
    try {
      const url = new URL(req.url, callbackOrigin);
      if (url.pathname === '/done') { res.end('Native browser login passed'); return; }
      assert.equal(req.headers.referer, undefined);
      assert.equal(url.searchParams.get('state'), 'native-state');
      const params = { client_id, grant_type: 'authorization_code', code: url.searchParams.get('code'), code_verifier: verifier, redirect_uri: redirect, resource: `${origin}/mcp` };
      for (const invalid of [{ code_verifier: 'x'.repeat(43) }, { redirect_uri: `${callbackOrigin}/wrong` }, { resource: `${origin}/wrong` }]) {
        assert.equal((await fetch(`${origin}/token`, { method: 'POST', body: new URLSearchParams({ ...params, ...invalid }) })).status, 400);
      }
      const exchange = await fetch(`${origin}/token`, { method: 'POST', body: new URLSearchParams(params) });
      assert.equal(exchange.status, 200); tokens.push(await exchange.json());
      assert.equal((await fetch(`${origin}/token`, { method: 'POST', body: new URLSearchParams(params) })).status, 400, 'Code was reusable');
      const remote = makeClient(); clients.push(remote);
      await remote.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens[0].access_token}` } } }));
      assert.deepEqual((await remote.listTools()).tools, nativeTools);
      const completed = await remote.callTool({ name: 'codex_run', arguments: { prompt: 'remote fixture', wait_sec: 5 } }); assert.equal(completed.isError, false);
      passed = true; res.writeHead(303, { Location: '/done', 'Referrer-Policy': 'no-referrer' }); res.end();
    } catch (error) { callbackError = error; res.writeHead(500); res.end('Native browser test failed'); }
  });
  browser = await chromium.launch(); const page = await browser.newPage();
  const origins = []; const cspErrors = [];
  page.on('request', r => { if (r.url() === `${origin}/login`) origins.push(r.headers().origin); });
  page.on('console', m => { if (m.type() === 'error' && /Content Security Policy|form-action/i.test(m.text())) cspErrors.push(m.text()); });
  const params = new URLSearchParams({ client_id, redirect_uri: redirect, response_type: 'code', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'codex:access', resource: `${origin}/mcp`, state: 'native-state' });
  const tabOne = await fetch(`${origin}/authorize?${params}`); const tabTwo = await fetch(`${origin}/authorize?${params}`);
  assert.notEqual(tabOne.headers.get('set-cookie').split('=')[0], tabTwo.headers.get('set-cookie').split('=')[0], 'One tab replaced another tab cookie');
  const request_id = /name="request_id" value="([^"]+)"/.exec(await tabOne.text())[1];
  const wrongCookie = await fetch(`${origin}/login`, { method: 'POST', headers: { Origin: origin, Cookie: tabTwo.headers.get('set-cookie').split(';')[0] }, body: new URLSearchParams({ request_id, username: 'admin', password }) });
  assert.equal(wrongCookie.status, 400);
  const originDenied = await fetch(`${origin}/login`, { method: 'POST', headers: { Origin: 'null' }, body: new URLSearchParams({ request_id, username: 'admin', password }) });
  assert.equal(originDenied.status, 403);
  await page.goto(`${origin}/authorize?${params}`);
  await page.getByLabel('MCP username', { exact: true }).fill('admin'); await page.getByLabel('MCP password', { exact: true }).fill('wrong');
  await page.getByRole('button', { name: 'Sign in and connect' }).click(); assert.match(await page.getByRole('alert').textContent(), /did not match/);
  await page.getByLabel('MCP username', { exact: true }).fill('admin'); await page.getByLabel('MCP password', { exact: true }).fill(password);
  await Promise.all([page.waitForURL(`${callbackOrigin}/done`), page.getByRole('button', { name: 'Sign in and connect' }).click()]);
  if (callbackError) throw callbackError;
  assert.ok(passed); assert.deepEqual(origins, [origin, origin]); assert.deepEqual(cspErrors, []);
  const refreshParams = { client_id, grant_type: 'refresh_token', refresh_token: tokens[0].refresh_token, resource: `${origin}/mcp` };
  const rotate = await fetch(`${origin}/token`, { method: 'POST', body: new URLSearchParams(refreshParams) }); assert.equal(rotate.status, 200); const rotated = await rotate.json();
  assert.equal((await fetch(`${origin}/token`, { method: 'POST', body: new URLSearchParams(refreshParams) })).status, 400);
  for (const token of [tokens[0].access_token, rotated.access_token]) {
    assert.equal((await fetch(`${origin}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status, 401, 'Reuse did not revoke the token family');
  }
  console.log('Native HTTP and Chromium passed: password retry, native form Origin, callback CSP, PKCE, one-use code, SDK client, remote job, refresh rotation, and family revocation.');
} finally {
  await browser?.close();
  for (const client of clients) { try { await client.close(); } catch {} }
  if (server) { server.stdin.end('stop\n'); await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]); if (server.exitCode === null) server.kill(); }
  await close(callback);
  // This fixture owns root. Leave it for diagnosis on failure; do not touch user workspaces.
}
