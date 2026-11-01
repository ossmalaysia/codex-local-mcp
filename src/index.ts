#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const tunnelMode = process.env.CODEX_MCP_TUNNEL;
  if (tunnelMode && !["quick", "named"].includes(tunnelMode)) throw new Error("CODEX_MCP_TUNNEL must be quick or named.");
  const tunnel = process.argv.includes("--tunnel") || !!tunnelMode;
  const transport = tunnel ? "http" : process.env.CODEX_MCP_TRANSPORT || "stdio";
  if (transport === "http") {
    const managedController = new AbortController();
    if (process.argv.includes("--managed")) {
      const stop = () => { managedController.abort(); process.stdin.destroy(); process.emit("SIGTERM"); };
      process.stdin.setEncoding("utf8");
      let input = "";
      process.stdin.on("data", chunk => {
        input = (input + chunk).slice(-1024);
        if (input.includes("stop\n") || input.includes("stop\r\n")) stop();
      });
      process.stdin.on("end", stop);
    }
    const { startHttpServer } = await import("./http.js");
    await startHttpServer({ tunnel, setupLogin: process.argv.includes("--setup-login"), signal: managedController.signal });
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
