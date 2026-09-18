import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Wrap the fake codex in a platform-native executable so spawn() finds it. */
export function installFakeCodex() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-bin-"));
  const target = path.join(here, "fake-codex.mjs");
  if (process.platform === "win32") {
    const shim = path.join(dir, "fake-codex.cmd");
    fs.writeFileSync(shim, `@echo off\r\nnode "${target}" %*\r\n`);
    return shim;
  }
  const shim = path.join(dir, "fake-codex.sh");
  fs.writeFileSync(shim, `#!/bin/sh\nexec node "${target}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return shim;
}

export function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-root-"));
}
