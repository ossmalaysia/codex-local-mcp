// Fresh-process startup comparison. Filesystem caches are not cleared.
import { performance } from 'node:perf_hooks';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ext = process.platform === 'win32' ? '.exe' : '';
const nativeIndex = process.argv.indexOf('--service');
const service = path.resolve(nativeIndex >= 0 ? process.argv[nativeIndex + 1] : `target/release/codex-mcp-service${ext}`);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-benchmark-'));
const env = { ...process.env, CODEX_BIN: path.resolve(`target/debug/examples/fake_codex${ext}`), CODEX_MCP_ROOT: root, CODEX_MCP_TRANSPORT: 'stdio', CODEX_SANDBOX_MODE: 'workspace-write', CODEX_MCP_ACTIVITY: '0', CODEX_MCP_APP_VIEW: 'false' };
const rows = [];
for (const [name, command, args] of [['typescript', process.execPath, [path.resolve('dist/index.js')]], ['rust', service, []]]) {
  const samples = [];
  for (let i = 0; i < 20; i++) {
    const client = new Client({ name: 'startup-benchmark', version: '1' });
    const start = performance.now();
    try {
      await client.connect(new StdioClientTransport({ command, args, env, stderr: 'pipe' }));
      if ((await client.listTools()).tools.length !== 4) throw new Error('Missing tools');
      samples.push(performance.now() - start);
    } finally { await client.close(); }
  }
  samples.sort((a, b) => a - b);
  rows.push({ name, samples: samples.length, medianMs: +((samples[9] + samples[10]) / 2).toFixed(2), p95Ms: +samples[18].toFixed(2) });
}
const report = { date: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version, method: '20 fresh processes each; initialization and tools/list; filesystem caches retained; no Codex task or model call', results: rows };
await fs.mkdir('artifacts', { recursive: true });
await fs.writeFile('artifacts/native-benchmark.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
await fs.rmdir(root);
