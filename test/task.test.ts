import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error - plain JS test helper
import { installFakeCodex, makeRoot } from "./setup-fake-codex.mjs";

// config reads env at import time, so the environment must be set up first.
const root: string = makeRoot();
process.env.CODEX_MCP_ROOT = root;
process.env.CODEX_BIN = installFakeCodex();
process.env.CODEX_TIMEOUT_SEC = "30";

let executeTask: typeof import("../src/task.js")["executeTask"];
let resolveWorkspace: typeof import("../src/workspace.js")["resolveWorkspace"];
let readArtifact: typeof import("../src/artifacts.js")["readArtifact"];

beforeAll(async () => {
  ({ executeTask } = await import("../src/task.js"));
  ({ resolveWorkspace } = await import("../src/workspace.js"));
  ({ readArtifact } = await import("../src/artifacts.js"));
});

describe("executeTask", () => {
  it("runs codex and reports the files it created", async () => {
    const result = await executeTask({ prompt: "make something", workspace: "demo" });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain("wrote notes.txt");

    const paths = result.artifacts.files.map((f) => f.path);
    expect(paths).toContain("notes.txt");
    expect(paths).toContain("output/img.png");
  });

  it("inlines small images and leaves text files as paths", async () => {
    const result = await executeTask({ prompt: "make something", workspace: "inline" });

    expect(result.artifacts.images).toHaveLength(1);
    expect(result.artifacts.images[0].path).toBe("output/img.png");
    expect(result.artifacts.images[0].mimeType).toBe("image/png");
    expect(result.artifacts.images[0].data.startsWith("iVBOR")).toBe(true);
    expect(result.artifacts.files.find((f) => f.path === "notes.txt")?.inlined).toBe(false);
  });

  it("reports only what the run touched, not pre-existing files", async () => {
    const dir = path.join(root, "repeat");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "untouched.txt"), "left alone");

    const result = await executeTask({ prompt: "second", workspace: "repeat" });
    const paths = result.artifacts.files.map((f) => f.path);

    expect(paths).toContain("notes.txt");
    expect(paths).not.toContain("untouched.txt");
  });

  it("surfaces a failing codex run without throwing", async () => {
    const result = await executeTask({ prompt: "please FAIL", workspace: "broken" });

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("refusing");
  });

  it("kills a hanging run and still reports the workspace", async () => {
    const result = await executeTask({ prompt: "HANG forever", workspace: "stuck", timeout_sec: 1 });

    expect(result.timedOut).toBe(true);
  }, 20_000);
});

describe("workspace safety", () => {
  it("refuses paths that escape the root", () => {
    expect(() => resolveWorkspace("../../etc")).toThrow(/escapes/);
    expect(() => resolveWorkspace(path.resolve("/tmp/elsewhere"))).toThrow(/absolute/);
  });

  it("allows nested names", () => {
    expect(resolveWorkspace("a/b")).toBe(path.resolve(root, "a/b"));
  });
});

describe("readArtifact", () => {
  it("refuses files outside the root", async () => {
    await expect(readArtifact(path.resolve(root, "..", "secret.txt"), 1000)).rejects.toThrow(
      /outside the workspace root/,
    );
  });

  it("returns text files as text", async () => {
    const dir = path.join(root, "readme-ws");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.txt"), "hello");

    const file = await readArtifact("readme-ws/a.txt", 1000);
    expect(file.text).toBe("hello");
    expect(file.base64).toBeUndefined();
  });
});
