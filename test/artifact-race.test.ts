import { expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

it("refuses a parent junction replaced after confinement validation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-race-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codex-race-outside-"));
  process.env.CODEX_MCP_ROOT = root;
  const parent = path.join(root, "parent");
  const parked = path.join(root, "parked");
  const target = path.join(parent, "file.txt");
  fs.mkdirSync(parent);
  fs.writeFileSync(target, "safe");
  fs.writeFileSync(path.join(outside, "file.txt"), "private outside data");
  const { openConfined } = await import("../src/artifacts.js");
  const originalOpen = fsp.open.bind(fsp);
  const mock = vi.spyOn(fsp, "open").mockImplementationOnce(async (...args) => {
    fs.renameSync(parent, parked);
    fs.symlinkSync(outside, parent, process.platform === "win32" ? "junction" : "dir");
    return originalOpen(...args);
  });
  try { await expect(openConfined(target)).rejects.toThrow(/outside|parent/); }
  finally { mock.mockRestore(); }
});
