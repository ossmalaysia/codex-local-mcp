import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const root: string = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sec-"));
const outside: string = fs.mkdtempSync(path.join(os.tmpdir(), "codex-outside-"));
process.env.CODEX_MCP_ROOT = root;
process.env.CODEX_TIMEOUT_SEC = "300";
process.env.CODEX_MAX_TIMEOUT_SEC = "30";

let mod: {
  childEnv: typeof import("../src/codex.js")["childEnv"];
  BoundedBuffer: typeof import("../src/codex.js")["BoundedBuffer"];
  readArtifact: typeof import("../src/artifacts.js")["readArtifact"];
  fileUri: typeof import("../src/artifacts.js")["fileUri"];
  uriToPath: typeof import("../src/artifacts.js")["uriToPath"];
  assertInsideRoot: typeof import("../src/workspace.js")["assertInsideRoot"];
  openInViewer: typeof import("../src/open.js")["openInViewer"];
};

beforeAll(async () => {
  const codex = await import("../src/codex.js");
  const artifacts = await import("../src/artifacts.js");
  const workspace = await import("../src/workspace.js");
  const open = await import("../src/open.js");
  mod = {
    childEnv: codex.childEnv,
    BoundedBuffer: codex.BoundedBuffer,
    readArtifact: artifacts.readArtifact,
    fileUri: artifacts.fileUri,
    uriToPath: artifacts.uriToPath,
    assertInsideRoot: workspace.assertInsideRoot,
    openInViewer: open.openInViewer,
  };
  fs.writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET");
});

describe("executable lookup cannot be hijacked from a workspace", () => {
  it("never puts a relative entry on the child PATH", () => {
    // path.dirname("codex") is ".", and the child's working directory is one
    // Codex can write to. A "." here means a dropped codex.cmd would win.
    const entries = (mod.childEnv().PATH ?? "").split(path.delimiter);

    expect(entries).not.toContain(".");
    expect(entries.every((e) => path.isAbsolute(e))).toBe(true);
  });
});

describe("model argument validation", () => {
  it("rejects values that would expand or break quoting on Windows", async () => {
    const { runCodex, UnsafeArgumentError } = await import("../src/codex.js");

    for (const bad of ["%COMSPEC%", "foo bar\\", 'a"b', "x&whoami"]) {
      await expect(
        runCodex({ prompt: "hi", cwd: root, timeoutSec: 5, model: bad }),
      ).rejects.toBeInstanceOf(UnsafeArgumentError);
    }
  });

  it("accepts ordinary model ids", async () => {
    const { quoteForShell } = await import("../src/codex.js");
    expect(quoteForShell("gpt-6-astra")).toBe("gpt-6-astra");
  });
});

describe("symlink confinement", () => {
  it("refuses a path that resolves outside the root through a link", async () => {
    const link = path.join(root, "escape");
    try {
      fs.symlinkSync(outside, link, "junction");
    } catch {
      return; // Links unavailable in this environment; nothing to assert.
    }

    await expect(mod.assertInsideRoot(path.join(link, "secret.txt"))).rejects.toThrow(
      /outside the workspace root/,
    );
    await expect(mod.readArtifact("escape/secret.txt", 10_000)).rejects.toThrow(
      /outside the workspace root/,
    );
  });

  it("still allows ordinary paths inside the root", async () => {
    const dir = path.join(root, "ok");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.txt"), "fine");

    await expect(mod.readArtifact("ok/a.txt", 10_000)).resolves.toMatchObject({ text: "fine" });
  });
});

describe("file URIs round-trip", () => {
  it("survives spaces and reserved characters", () => {
    const dir = path.join(root, "uri");
    fs.mkdirSync(dir, { recursive: true });

    for (const name of ["plain.txt", "a b.txt", "a#b.txt", "a%20b.txt"]) {
      const abs = path.join(dir, name);
      fs.writeFileSync(abs, name);
      expect(mod.uriToPath(mod.fileUri(abs))).toBe(abs);
    }
  });
});

describe("read limits are enforced on bytes actually read", () => {
  it("refuses a file over the limit", async () => {
    const dir = path.join(root, "limits");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "big.txt"), "x".repeat(5000));

    await expect(mod.readArtifact("limits/big.txt", 1000)).rejects.toThrow(/limit/);
  });

  it("returns unknown binary types as base64 rather than mangled text", async () => {
    const dir = path.join(root, "binary");
    fs.mkdirSync(dir, { recursive: true });
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x42, 0x80]);
    fs.writeFileSync(path.join(dir, "thing.bin"), bytes);

    const file = await mod.readArtifact("binary/thing.bin", 10_000);
    expect(file.text).toBeUndefined();
    expect(file.mimeType).toBe("application/octet-stream");
    expect(Buffer.from(file.base64!, "base64").equals(bytes)).toBe(true);
  });
});

describe("timeout clamping", () => {
  it("clamps the DEFAULT to the configured maximum, not just requests", async () => {
    // CODEX_TIMEOUT_SEC=300 with CODEX_MAX_TIMEOUT_SEC=30. The default branch
    // used to return 300 without ever consulting the maximum.
    const { clampTimeout } = await import("../src/task.js");

    expect(clampTimeout(undefined)).toBe(30);
    expect(clampTimeout(0)).toBe(30);
    expect(clampTimeout(9999)).toBe(30);
    expect(clampTimeout(10)).toBe(10);
  });

  it("never returns a delay setTimeout would treat as zero", async () => {
    const { clampTimeout } = await import("../src/task.js");
    expect(clampTimeout(Number.MAX_SAFE_INTEGER) * 1000).toBeLessThan(2 ** 31);
  });
});

describe("bounded output buffering", () => {
  it("never holds more than the configured budget", () => {
    const buf = new mod.BoundedBuffer(1000);
    for (let i = 0; i < 1000; i++) buf.push("y".repeat(1000));

    const out = buf.toString();
    expect(out.length).toBeLessThan(1200);
    expect(out).toContain("characters omitted");
  });
});

describe("viewer launch failures are reported, not thrown", () => {
  it.skipIf(process.platform === "win32")("resolves with a message when the opener is missing", async () => {
    const result = await mod.openInViewer(path.join(root, "nope.png"));
    // Either it opened (a desktop is present) or it reported a failure string.
    expect(result === undefined || typeof result === "string").toBe(true);
  });
});
