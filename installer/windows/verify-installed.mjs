import fs from "node:fs";
import { Client } from "./app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { InMemoryTransport } from "./app/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js";
import { createServer } from "./app/dist/server.js";
const manifest = JSON.parse(fs.readFileSync(new URL("./release-manifest.json", import.meta.url), "utf8").replace(/^\uFEFF/, ""));
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createServer();
const client = new Client({ name: "installed-release-verification", version: "1" });
try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  if (client.getServerVersion()?.version !== manifest.version) throw new Error("Installed MCP protocol version does not match its release.");
  const tools = await client.listTools();
  if (!tools.tools.some(tool => tool.name === "codex_run")) throw new Error("Installed MCP server is missing Codex tools.");
  console.log(`Installed MCP protocol and release version verified: ${manifest.version}.`);
} finally { await client.close(); await server.close(); }
