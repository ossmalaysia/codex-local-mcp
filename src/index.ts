#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
  // stdout is the MCP transport; anything human-facing must go to stderr.
  console.error(`codex-local-mcp ready (root: ${config.root}, bin: ${config.codexBin})`);
}

main().catch((err) => {
  console.error("codex-local-mcp failed to start:", err);
  process.exit(1);
});
