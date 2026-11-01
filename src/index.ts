#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const tunnel = process.argv.includes("--tunnel") || process.env.CODEX_MCP_TUNNEL === "quick";
  const transport = tunnel ? "http" : process.env.CODEX_MCP_TRANSPORT || "stdio";
  if (transport === "http") {
    const { startHttpServer } = await import("./http.js");
    await startHttpServer({ tunnel, setupLogin: process.argv.includes("--setup-login") });
    return;
  }
  if (transport !== "stdio") throw new Error("CODEX_MCP_TRANSPORT must be stdio or http.");
  await createServer().connect(new StdioServerTransport());
  // stdout is the MCP transport; anything human-facing must go to stderr.
  console.error(`codex-local-mcp ready (root: ${config.root}, bin: ${config.codexBin})`);
}

main().catch((err) => {
  console.error("codex-local-mcp failed to start:", err);
  process.exit(1);
});
