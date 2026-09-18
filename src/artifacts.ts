import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { b64Length, makePreview } from "./preview.js";

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function imageMimeType(filePath: string): string | undefined {
  return IMAGE_MIME[path.extname(filePath).toLowerCase()];
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

function fileUri(absPath: string): string {
  return `file:///${absPath.replace(/\\/g, "/").replace(/^\//, "")}`;
}

/**
 * Turn the list of changed files into something a calling LLM can use: every
 * path, plus base64 for images small enough to be worth spending tokens on.
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
      bytes = (await fs.stat(abs)).size;
    } catch {
      continue;
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

    // Send the original only when its ENCODED size fits; otherwise downscale.
    if (b64Length(bytes) <= remaining) {
      try {
        const data = (await fs.readFile(abs)).toString("base64");
        images.push({ path: rel, mimeType, data });
        files.push({ path: rel, bytes, inlined: true });
        links.push(link);
        spent += data.length;
        continue;
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

/** Read one artifact on demand. Refuses anything outside the workspace root. */
export async function readArtifact(target: string, maxBytes: number): Promise<ReadArtifactResult> {
  const abs = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(config.root, target);

  if (abs !== config.root && !abs.startsWith(config.root + path.sep)) {
    throw new Error(`refusing to read "${target}": outside the workspace root (${config.root})`);
  }

  const st = await fs.stat(abs);
  if (st.size > maxBytes) {
    throw new Error(
      `"${target}" is ${st.size} bytes, over the ${maxBytes} byte limit. Raise max_bytes or read it another way.`,
    );
  }

  const buf = await fs.readFile(abs);
  const mimeType = imageMimeType(abs);
  return mimeType
    ? { absPath: abs, bytes: st.size, mimeType, base64: buf.toString("base64") }
    : { absPath: abs, bytes: st.size, text: buf.toString("utf8") };
}
