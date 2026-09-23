import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
// @ts-expect-error - plain JS test helper
import { installFakeCodex, makeRoot } from "./setup-fake-codex.mjs";

// config reads env at import time, so the environment must be set up first.
const root: string = makeRoot();
process.env.CODEX_MCP_ROOT = root;
process.env.CODEX_BIN = installFakeCodex();

let client: Client;

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

beforeAll(async () => {
  const { createServer } = await import("../src/server.js");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  client = new Client({ name: "image-size-test", version: "1.0.0" });
  await client.connect(clientSide);
});

afterAll(async () => {
  await client?.close();
});

/** Call the image tool through a real MCP client. Never opens a viewer. */
async function generate(args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({
    name: "codex_generate_image",
    arguments: { prompt: "a red cube", open: false, ...args },
  })) as ToolResult;
}

function allText(result: ToolResult): string {
  return result.content.map((c) => c.text ?? "").join("\n");
}

/** The fake Codex writes the prompt it received on stdin into notes.txt. */
function promptSeenByCodex(workspace: string): string {
  return fs.readFileSync(path.join(root, workspace, "notes.txt"), "utf8");
}

describe("size and quality reach Codex", () => {
  it("passes the requested size and quality through to the prompt", async () => {
    const result = await generate({ workspace: "sized", size: "800x600", quality: "high" });

    expect(result.isError).toBeFalsy();
    const prompt = promptSeenByCodex("sized");
    expect(prompt).toContain("Size: 800x600.");
    expect(prompt).toContain("Quality: high.");
  });

  it("uses the fast defaults when size and quality are omitted", async () => {
    await generate({ workspace: "defaults" });

    const prompt = promptSeenByCodex("defaults");
    expect(prompt).toContain("Size: 1024x1024.");
    expect(prompt).toContain("Quality: low.");
  });

  it("passes the caller's own prompt through unchanged", async () => {
    await generate({ workspace: "verbatim", prompt: "a lighthouse at dawn, watercolour" });

    expect(promptSeenByCodex("verbatim")).toContain("a lighthouse at dawn, watercolour");
  });
});

describe("malformed sizes are rejected before Codex runs", () => {
  for (const bad of ["banana", "1024", "0x100", "99999x99999", "-5x5", "10x10x10"]) {
    it(`rejects "${bad}"`, async () => {
      const workspace = `bad-${bad.replace(/[^a-z0-9]/gi, "_")}`;
      const result = await generate({ workspace, size: bad });

      expect(result.isError).toBe(true);
      expect(allText(result)).toMatch(/Invalid size/);
      // No Codex run happened: the fake would have written notes.txt.
      expect(fs.existsSync(path.join(root, workspace, "notes.txt"))).toBe(false);
    });
  }
});

describe("size parsing", () => {
  it("accepts WIDTHxHEIGHT in any case, with surrounding whitespace, and auto", async () => {
    const { parseImageSize } = await import("../src/task.js");

    expect(parseImageSize("1536x1024")).toEqual({ width: 1536, height: 1024 });
    expect(parseImageSize(" 800X600 ")).toEqual({ width: 800, height: 600 });
    expect(parseImageSize("AUTO")).toBe("auto");
  });

  it("does not impose the gpt-image-2 API limits", async () => {
    // Codex's built-in image tool has produced an exact 800x600, which is below
    // the API's 655,360-pixel minimum and not a multiple of 16 on one side.
    const { parseImageSize } = await import("../src/task.js");

    expect(parseImageSize("800x600")).toEqual({ width: 800, height: 600 });
    expect(parseImageSize("1000x1000")).toEqual({ width: 1000, height: 1000 });
  });
});

describe("the real output size is reported", () => {
  it("lists the actual dimensions of each generated image", async () => {
    // The fake Codex always writes a 1x1 PNG.
    const result = await generate({ workspace: "dims", size: "1x1" });

    expect(allText(result)).toMatch(/output\/img\.png \(\d+ bytes, 1x1\)/);
  });

  it("flags a mismatch between the requested and actual size", async () => {
    const result = await generate({ workspace: "mismatch", size: "800x600" });

    expect(allText(result)).toContain("output/img.png is 1x1, not the requested 800x600.");
  });

  it("says nothing when the size matches", async () => {
    const result = await generate({ workspace: "match", size: "1x1" });

    expect(allText(result)).not.toContain("not the requested");
  });

  it("says nothing when the caller asked for auto", async () => {
    const result = await generate({ workspace: "auto", size: "auto" });

    expect(allText(result)).not.toContain("not the requested");
  });
});
