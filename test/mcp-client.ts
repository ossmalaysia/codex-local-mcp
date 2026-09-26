import { afterAll, beforeAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

export type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

/**
 * Connect a real MCP client to a fresh server over an in-memory transport, so
 * tests exercise schema validation and result formatting end to end.
 *
 * Set any CODEX_* environment variables BEFORE calling this: config reads them
 * when the server module is first imported, which happens here.
 */
export async function connectClient(name: string): Promise<Client> {
  const { createServer } = await import("../src/server.js");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(clientSide);
  return client;
}

/**
 * Register a connected client for the current test file: connects before the
 * tests and closes after. Call at module level, after setting the environment.
 */
export function useMcpClient(name: string) {
  let client: Client | undefined;

  beforeAll(async () => {
    client = await connectClient(name);
  });

  afterAll(async () => {
    await client?.close();
  });

  const connected = (): Client => {
    if (!client) throw new Error("MCP client used before beforeAll connected it");
    return client;
  };

  return {
    /** The underlying client, for calls that need request options. */
    client: connected,
    call: async (tool: string, args: Record<string, unknown>): Promise<ToolResult> =>
      (await connected().callTool({ name: tool, arguments: args })) as ToolResult,
  };
}

/** All text content of a result, joined, for assertions. */
export function resultText(result: ToolResult): string {
  return result.content.map((c) => c.text ?? "").join("\n");
}

/** The job id from a "status: running" result. */
export function jobIdOf(result: ToolResult): string {
  const match = /job_id: (\S+)/.exec(resultText(result));
  if (!match) throw new Error(`no job_id in: ${resultText(result)}`);
  return match[1];
}
