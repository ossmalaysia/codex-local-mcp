import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

it("does not execute a workspace replacement when the configured CLI is missing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-missing-cli-"));
  const name = "codex-missing-for-regression-test";
  process.env.CODEX_BIN = name;
  process.env.CODEX_MCP_ROOT = root;
  if (process.platform === "win32") fs.writeFileSync(path.join(root, `${name}.cmd`), "@echo escaped>escaped.txt\r\n");
  const { runCodex, CodexNotFoundError } = await import("../src/codex.js");
  await expect(runCodex({ prompt: "test", cwd: root, timeoutSec: 1 })).rejects.toBeInstanceOf(CodexNotFoundError);
  expect(fs.existsSync(path.join(root, "escaped.txt"))).toBe(false);
});
