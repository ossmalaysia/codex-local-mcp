import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { config } from "./config.js";
import { b64Length, makePreview } from "./preview.js";
import { assertInsideRoot } from "./workspace.js";

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Extensions we are willing to hand back as text. Everything else is binary. */
const TEXT_EXT = new Set([
  ".txt", ".md", ".json", ".yaml", ".yml", ".toml", ".ini", ".csv", ".tsv",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs",
  ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".sh", ".bash", ".ps1", ".bat",
  ".cmd", ".html", ".htm", ".css", ".scss", ".xml", ".svg", ".sql", ".env",
  ".gitignore", ".log", ".diff", ".patch",
]);

export function imageMimeType(filePath: string): string | undefined {
  return IMAGE_MIME[path.extname(filePath).toLowerCase()];
}

export function isTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === "" || TEXT_EXT.has(ext);
}

export interface FileReport {
  path: string;
  bytes: number;
  inlined: boolean;
  note?: string;
}

/** A file the caller can fetch on demand instead of receiving inline. */
export interface ResourceLink {
  uri: string;
  name: string;
  mimeType?: string;
  description: string;
}

export interface InlineImage {
  path: string;
  mimeType: string;
  data: string;
  note?: string;
}

export interface ArtifactReport {
  files: FileReport[];
  images: InlineImage[];
  links: ResourceLink[];
  truncated: boolean;
}

/**
 * pathToFileURL handles drive letters, POSIX roots and percent-encoding of
 * characters such as # and %, which hand-built URIs get wrong in both
 * directions.
 */
export function fileUri(absPath: string): string {
  return pathToFileURL(absPath).href;
}

export function uriToPath(uri: string): string {
  return fileURLToPath(uri);
}

/**
 * Turn the list of changed files into something a calling LLM can use: every
 * path as a fetchable link, plus inline previews for images small enough to be
 * worth the tokens. Budgets are counted in base64 characters because that is
 * what the client receives.
 */
export async function collectArtifacts(
  workspace: string,
  relPaths: string[],
): Promise<ArtifactReport> {
  const truncated = relPaths.length > config.maxReportedFiles;
  const selected = relPaths.slice(0, config.maxReportedFiles);

  const files: FileReport[] = [];
  const images: InlineImage[] = [];
  const links: ResourceLink[] = [];
  let spent = 0;

  for (const rel of selected) {
    const abs = path.join(workspace, rel);

    let bytes = 0;
    try {
      await assertInsideRoot(abs);
      bytes = (await fs.stat(abs)).size;
    } catch {
      continue; // Vanished, or a link pointing outside the root.
    }

    const mimeType = imageMimeType(rel);
    const link: ResourceLink = {
      uri: fileUri(abs),
      name: rel,
      mimeType,
      description: `${bytes} bytes, produced in this workspace`,
    };

    if (!mimeType || bytes === 0) {
      files.push({ path: rel, bytes, inlined: false });
      links.push(link);
      continue;
    }

    const remaining = Math.min(config.maxInlineImageB64, config.maxResponseB64 - spent);
    if (remaining <= 0) {
      files.push({ path: rel, bytes, inlined: false, note: "response image budget spent" });
      links.push(link);
      continue;
    }

    // Send the original only when its ENCODED size fits. The stat above is a
    // cheap pre-filter; the authoritative check is on the bytes actually read,
    // because the file can change in between.
    if (b64Length(bytes) <= remaining) {
      try {
        const data = (await fs.readFile(abs)).toString("base64");
        if (data.length <= remaining) {
          images.push({ path: rel, mimeType, data });
          files.push({ path: rel, bytes, inlined: true });
          links.push(link);
          spent += data.length;
          continue;
        }
        // It grew after the stat; fall through to the preview path.
      } catch {
        files.push({ path: rel, bytes, inlined: false });
        links.push(link);
        continue;
      }
    }

    const preview = await makePreview(abs, remaining);
    if (preview) {
      images.push({ path: rel, mimeType: preview.mimeType, data: preview.data, note: preview.note });
      files.push({ path: rel, bytes, inlined: true, note: preview.note });
      spent += preview.data.length;
    } else {
      files.push({ path: rel, bytes, inlined: false, note: "could not be shrunk to fit" });
    }
    links.push(link);
  }

  return { files, images, links, truncated };
}

export interface ReadArtifactResult {
  absPath: string;
  bytes: number;
  mimeType?: string;
  base64?: string;
  text?: string;
}

/**
 * Read one artifact on demand. Refuses anything that resolves outside the
 * workspace root, following symlinks. The size limit is enforced on the bytes
 * actually read, not on an earlier stat.
 */
export async function readArtifact(target: string, maxBytes: number): Promise<ReadArtifactResult> {
  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(config.root, target);
  const real = await assertInsideRoot(abs);

  const handle = await fs.open(real, "r");
  try {
    const stat = await handle.stat();
    if (stat.size > maxBytes) {
      throw new Error(
        `"${target}" is ${stat.size} bytes, over the ${maxBytes} byte limit. Raise max_bytes or read it another way.`,
      );
    }
    // Read at most maxBytes + 1 so growth between stat and read is caught.
    const buf = Buffer.alloc(Math.min(stat.size, maxBytes) + 1);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead > maxBytes) {
      throw new Error(`"${target}" grew past the ${maxBytes} byte limit while being read.`);
    }
    const data = buf.subarray(0, bytesRead);

    const mimeType = imageMimeType(real);
    if (mimeType) return { absPath: real, bytes: bytesRead, mimeType, base64: data.toString("base64") };
    if (isTextFile(real)) return { absPath: real, bytes: bytesRead, text: data.toString("utf8") };
    // Unknown binary: base64 rather than lossy UTF-8 decoding.
    return {
      absPath: real,
      bytes: bytesRead,
      mimeType: "application/octet-stream",
      base64: data.toString("base64"),
    };
  } finally {
    await handle.close();
  }
}
