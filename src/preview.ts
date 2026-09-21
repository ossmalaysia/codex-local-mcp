import sharp from "sharp";

/** Progressively smaller and lossier attempts until one fits the budget. */
const ATTEMPTS: Array<{ width: number; quality: number }> = [
  { width: 1280, quality: 80 },
  { width: 1024, quality: 75 },
  { width: 900, quality: 70 },
  { width: 768, quality: 65 },
  { width: 640, quality: 55 },
  { width: 512, quality: 45 },
];

/** base64 length for a buffer of n bytes, without doing the encoding. */
export function b64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

export interface Preview {
  data: string;
  mimeType: string;
  note: string;
}

/**
 * Shrink an image until its BASE64 form fits `maxB64`. Takes the bytes that
 * were already read through a validated handle, rather than a path, so the file
 * is never re-opened by name. The original on disk is never touched.
 *
 * Note this is not an optional nicety: gpt-image-2 requires at least 655,360
 * pixels per image, so a generated PNG is essentially always too large to
 * inline untouched.
 */
export async function makePreview(source: Buffer, maxB64: number): Promise<Preview | undefined> {
  for (const { width, quality } of ATTEMPTS) {
    try {
      const buf = await sharp(source)
        .resize({ width, withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
      const encoded = buf.toString("base64");
      if (encoded.length <= maxB64) {
        return {
          data: encoded,
          mimeType: "image/jpeg",
          note: `preview ${width}px q${quality}, ${encoded.length} b64 chars (full resolution on disk)`,
        };
      }
    } catch {
      return undefined; // Not a decodable image; caller falls back to a link.
    }
  }
  return undefined;
}
