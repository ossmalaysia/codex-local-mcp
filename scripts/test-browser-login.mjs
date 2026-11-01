import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installFakeCodex, makeRoot } from '../test/setup-fake-codex.mjs';

process.env.CODEX_BIN = installFakeCodex();
process.env.CODEX_MCP_ROOT = makeRoot();
const bundleIndex = process.argv.indexOf('--bundle-root');
const moduleUrl = bundleIndex >= 0
  ? pathToFileURL(path.resolve(process.argv[bundleIndex + 1], 'app/dist/http.js')).href
  : new URL('../dist/http.js', import.meta.url).href;
const { createHttpApp } = await import(moduleUrl);
const password = 'browser-policy-test-password-only';
const verifier = randomBytes(32).toString('base64url');
const app = createServer();
const callback = createServer();
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
let browser;
try {
  await listen(app); await listen(callback);
  const origin = `http://127.0.0.1:${app.address().port}`;
  const callbackOrigin = `http://127.0.0.1:${callback.address().port}`;
  const redirect = `${callbackOrigin}/callback`;
  app.on('request', createHttpApp({ publicUrl: new URL(origin), host: '127.0.0.1', port: app.address().port, username: 'admin', password }, async () => {}));
  const registration = await fetch(`${origin}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Browser regression test', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }) });
  assert.equal(registration.status, 201);
  const { client_id } = await registration.json();
  let callbackPassed = false;
  let callbackError;
  callback.on('request', async (req, res) => {
    try {
      const url = new URL(req.url, callbackOrigin);
      if (url.pathname === '/done') { res.end('Browser login passed'); return; }
      assert.equal(url.pathname, '/callback');
      assert.equal(req.headers.referer, undefined, 'Authorization URL leaked to the callback origin');
      const exchange = await fetch(`${origin}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id, grant_type: 'authorization_code', code: url.searchParams.get('code') || '', code_verifier: verifier, redirect_uri: redirect, resource: `${origin}/mcp` }) });
      assert.equal(exchange.status, 200, 'PKCE exchange failed');
      const token = await exchange.json();
      const mcp = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'browser-regression-test', version: '1' } } }) });
      assert.equal(mcp.status, 200);
      assert.ok((await mcp.json()).result?.serverInfo, 'Authenticated MCP initialization failed');
      callbackPassed = true;
      res.writeHead(303, { Location: '/done', 'Referrer-Policy': 'no-referrer' }); res.end();
    } catch (error) { callbackError = error; res.writeHead(500); res.end('Browser test failed'); }
  });
  browser = await chromium.launch();
  const page = await browser.newPage();
  const origins = [];
  const policyErrors = [];
  page.on('request', request => { if (request.url() === `${origin}/login`) origins.push(request.headers().origin); });
  page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|form-action/i.test(message.text())) policyErrors.push(message.text()); });
  const query = new URLSearchParams({ client_id, redirect_uri: redirect, response_type: 'code', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'codex:access', resource: `${origin}/mcp` });
  await page.goto(`${origin}/authorize?${query}`);
  await page.getByLabel('MCP username', { exact: true }).fill('admin');
  await page.getByLabel('MCP password', { exact: true }).fill('wrong');
  await page.getByRole('button', { name: 'Sign in and connect' }).click();
  assert.match(await page.getByRole('alert').textContent(), /did not match/);
  await page.getByLabel('MCP username', { exact: true }).fill('admin');
  await page.getByLabel('MCP password', { exact: true }).fill(password);
  await Promise.all([page.waitForURL(`${callbackOrigin}/done`), page.getByRole('button', { name: 'Sign in and connect' }).click()]);
  if (callbackError) throw callbackError;
  assert.ok(callbackPassed);
  assert.equal(await page.locator('body').textContent(), 'Browser login passed');
  assert.deepEqual(origins, [origin, origin], 'Browser form POST used an opaque Origin');
  assert.deepEqual(policyErrors, [], 'CSP blocked the OAuth callback');
  console.log('Chromium passed: native form submission, Origin, password retry, cross-origin callback, PKCE, authenticated MCP, and no callback referrer leak. No AI model was called.');
} finally { await browser?.close(); await close(app); await close(callback); }
