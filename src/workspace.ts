import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

/** Directories that are never worth snapshotting or reporting as artifacts. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".next",
  "dist",
  ".codex",
]);

export class WorkspaceError extends Error {}

/**
 * Turn a caller-supplied workspace name into an absolute path under the root.
 * Anything that would escape the root is refused rather than clamped, so a
 * caller never silently gets a different directory than it asked for.
 */
export function resolveWorkspace(name?: string): string {
  const slug = name?.trim()
    ? name.trim()
    : `ws-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  if (path.isAbsolute(slug)) {
    throw new WorkspaceError(
      `workspace must be a relative name under the workspace root, got absolute path: ${slug}`,
    );
  }

  const target = path.resolve(config.root, slug);
  if (target !== config.root && !target.startsWith(config.root + path.sep)) {
    throw new WorkspaceError(`workspace "${slug}" escapes the workspace root`);
  }
  return target;
}

export async function ensureWorkspace(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** relative path -> "mtimeMs:size" fingerprint. */
export type Snapshot = Map<string, string>;

export async function snapshot(dir: string): Promise<Snapshot> {
  const out: Snapshot = new Map();
  await walk(dir, dir, out, 0);
  return out;
}

async function walk(root: string, current: string, out: Snapshot, depth: number): Promise<void> {
  if (depth > 12) return;
  let entries;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const abs = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(root, abs, out, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const st = await fs.stat(abs);
      out.set(path.relative(root, abs).split(path.sep).join("/"), `${st.mtimeMs}:${st.size}`);
    } catch {
      // File vanished between readdir and stat; nothing to report.
    }
  }
}

/** Paths that are new or whose contents changed between the two snapshots. */
export function changedFiles(before: Snapshot, after: Snapshot): string[] {
  const changed: string[] = [];
  for (const [rel, fingerprint] of after) {
    if (before.get(rel) !== fingerprint) changed.push(rel);
  }
  return changed.sort();
}
