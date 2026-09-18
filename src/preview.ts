import sharp from "sharp";

/** Progressively smaller/lossier attempts until one fits the inline budget. */
const ATTEMPTS: Array<{ width: number; quality: number }> = [
  { width: 1280, quality: 80 },
  { width: 1024, quality: 75 },
  { width: 768, quality: 65 },
  { width: 512, quality: 55 },
];

export interface Preview {
  data: string;
  mimeType: string;
  note: string;
}

/**
 * Shrink an image that is too large to inline. The original file on disk is
 * never touched - this only produces something small enough for the caller to
 * actually see, which a bare file path does not.
 */
export async function makePreview(absPath: string, maxBytes: number): Promise<Preview | undefined> {
  for (const { width, quality } of ATTEMPTS) {
    try {
      const buf = await sharp(absPath)
        .resize({ width, withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
      if (buf.length <= maxBytes) {
        return {
          data: buf.toString("base64"),
          mimeType: "image/jpeg",
          note: `preview: ${width}px wide, q${quality}, ${buf.length} bytes (full-resolution file is on disk)`,
        };
      }
    } catch {
      return undefined; // Not a decodable image; caller falls back to path-only.
    }
  }
  return undefined;
}
