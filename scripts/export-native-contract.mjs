// Freeze the public TypeScript contract for the staged native implementation.
import fs from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server.js';

const server = createServer();
const client = new Client({ name: 'native-contract', version: '1' });
const [a, b] = InMemoryTransport.createLinkedPair();
try {
  await server.connect(a);
  await client.connect(b);
  const contract = {
    tools: (await client.listTools()).tools,
    resources: (await client.listResources()).resources,
    resourceTemplates: (await client.listResourceTemplates()).resourceTemplates,
  };
  const contents = JSON.stringify(contract, null, 2) + '\n';
  const file = new URL('../native/service/contract.json', import.meta.url);
  if (process.argv.includes('--check')) {
    if (await fs.readFile(file, 'utf8') !== contents) throw new Error('Native MCP contract differs. Regenerate and review it.');
  } else await fs.writeFile(file, contents);
} finally {
  await client.close(); await server.close();
}
