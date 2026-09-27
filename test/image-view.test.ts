import { describe, expect, it } from "vitest";
import { useMcpClient, type ToolResult } from "./mcp-client.js";
import { parseToolResult, type ToolResultLike } from "../ui/parse.js";
// @ts-expect-error - plain JS test helper
import { installFakeCodex, makeRoot } from "./setup-fake-codex.mjs";

// config reads env at import time, so the environment must be set up first.
process.env.CODEX_MCP_ROOT = makeRoot();
process.env.CODEX_BIN = installFakeCodex();

const mcp = useMcpClient("image-view-test");
const VIEW_URI = "ui://codex-local-mcp/image-viewer.html";

describe("the in-chat view is advertised as an MCP App", () => {
  it("links codex_generate_image, and only it, to the view", async () => {
    const { tools } = await mcp.client().listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(byName.codex_generate_image._meta?.ui).toEqual({ resourceUri: VIEW_URI });
    // Text tasks and polls render no view; the image call's own view polls.
    expect(byName.codex_run._meta?.ui).toBeUndefined();
    expect(byName.codex_job_result._meta?.ui).toBeUndefined();
  });

  it("serves the view as a self-contained MCP App resource", async () => {
    const { contents } = await mcp.client().readResource({ uri: VIEW_URI });
    const html = String((contents[0] as { text?: string }).text);

    expect(contents[0].mimeType).toBe("text/html;profile=mcp-app");
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('id="root"');
    // The host sandbox blocks the network, so nothing may load from elsewhere.
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
  });
});

describe("the view reads what the server really returns", () => {
  it("shows the image from a finished generation", async () => {
    const result = (await mcp.call("codex_generate_image", {
      prompt: "a red cube",
      workspace: "view-done",
      size: "1x1",
      open: false,
    })) as ToolResultLike;

    const state = parseToolResult(result);
    expect(state.kind).toBe("done");
    if (state.kind !== "done") return;
    expect(state.isError).toBe(false);
    expect(state.images).toHaveLength(1);
    expect(state.images[0].path).toBe("output/img.png");
    expect(state.images[0].src).toMatch(/^data:image\/png;base64,/);
    expect(state.workspace).toContain("view-done");
  });

  it("recognises a still-running generation and its job id", async () => {
    const result = (await mcp.call("codex_generate_image", {
      prompt: "a cube SLOW:1500",
      workspace: "view-running",
      open: false,
      wait_sec: 0,
    })) as ToolResultLike;

    const state = parseToolResult(result);
    expect(state.kind).toBe("running");
    if (state.kind !== "running") return;
    expect(state.jobId).toMatch(/^[0-9a-f-]{36}$/);

    // And the poll the view makes delivers the image.
    const done = (await mcp.call("codex_job_result", {
      job_id: state.jobId,
      wait_sec: 20,
    })) as ToolResultLike;
    const final = parseToolResult(done);
    expect(final.kind).toBe("done");
    if (final.kind === "done") expect(final.images).toHaveLength(1);
  }, 20_000);

  it("surfaces the size-mismatch note", async () => {
    const result = (await mcp.call("codex_generate_image", {
      prompt: "a red cube",
      workspace: "view-mismatch",
      size: "800x600",
      open: false,
    })) as ToolResultLike;

    const state = parseToolResult(result);
    expect(state.kind === "done" && state.notes.join()).toContain("not the requested 800x600");
  });

  it("shows the error when the call fails", async () => {
    const result = (await mcp.call("codex_generate_image", {
      prompt: "a red cube",
      size: "banana",
    })) as ToolResult as ToolResultLike;

    const state = parseToolResult(result);
    expect(state.kind === "done" && state.isError).toBe(true);
    expect(state.kind === "done" && state.message).toMatch(/Invalid size "banana"/);
  });
});

describe("the view never builds an unsafe image source", () => {
  it("ignores image blocks with non-raster types", () => {
    const state = parseToolResult({
      content: [
        { type: "text", text: "Image: evil.html" },
        { type: "image", mimeType: "text/html", data: "PHNjcmlwdD4=" },
        { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" },
      ],
    });

    expect(state.kind === "done" && state.images).toEqual([]);
  });

  it("keeps filenames as plain data rather than markup", () => {
    const state = parseToolResult({
      content: [
        { type: "text", text: 'Image: output/<img src=x onerror=alert(1)>.png' },
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      ],
    });

    // Parsed as a literal string; the view inserts it with textContent.
    expect(state.kind === "done" && state.images[0].path).toBe("output/<img src=x onerror=alert(1)>.png");
  });
});
