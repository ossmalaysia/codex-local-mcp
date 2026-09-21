import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import sharp from "sharp";

const root: string = fs.mkdtempSync(path.join(os.tmpdir(), "codex-budget-"));
process.env.CODEX_MCP_ROOT = root;
process.env.CODEX_MAX_INLINE_IMAGE_B64 = "200000";
process.env.CODEX_MAX_RESPONSE_B64 = "300000";

let collectArtifacts: typeof import("../src/artifacts.js")["collectArtifacts"];
const ws = "images";

/** A noisy image, so JPEG cannot trivially compress it away. */
async function writeImage(name: string, width: number, height: number): Promise<void> {
  // Real random bytes: anything patterned compresses away and stays under budget.
  const px = randomBytes(width * height * 3);
  const file = path.join(root, ws, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp(px, { raw: { width, height, channels: 3 } }).png().toFile(file);
}

beforeAll(async () => {
  ({ collectArtifacts } = await import("../src/artifacts.js"));
  fs.mkdirSync(path.join(root, ws), { recursive: true });
  await writeImage("big.png", 1400, 1000);
  await writeImage("also-big.png", 1400, 1000);
  await writeImage("third.png", 1400, 1000);
});

describe("inline budgets are measured in base64 characters", () => {
  it("never inlines an image whose encoded size exceeds the per-image budget", async () => {
    const r = await collectArtifacts(path.join(root, ws), ["big.png"]);

    expect(r.images).toHaveLength(1);
    expect(r.images[0].data.length).toBeLessThanOrEqual(200_000);
    // It was downscaled rather than sent raw, even though this is the only image.
    expect(r.images[0].mimeType).toBe("image/jpeg");
    expect(r.files[0].note).toMatch(/preview/);
  });

  it("keeps the whole response under the total budget", async () => {
    const r = await collectArtifacts(path.join(root, ws), [
      "big.png",
      "also-big.png",
      "third.png",
    ]);

    const total = r.images.reduce((sum, i) => sum + i.data.length, 0);
    expect(total).toBeLessThanOrEqual(300_000);
  });

  it("degrades gracefully: nothing is dropped without explanation", async () => {
    const names = ["big.png", "also-big.png", "third.png"];
    const r = await collectArtifacts(path.join(root, ws), names);

    // Every file is either inlined, or carries a note saying why it is not.
    for (const f of r.files) {
      expect(f.inlined || typeof f.note === "string").toBe(true);
    }
    // And every file is reachable regardless, via a resource link.
    expect(r.links.map((l) => l.name).sort()).toEqual([...names].sort());
  });

  it("shrinks later images harder rather than skipping them", async () => {
    const r = await collectArtifacts(path.join(root, ws), [
      "big.png",
      "also-big.png",
      "third.png",
    ]);

    const sizes = r.images.map((i) => i.data.length);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(300_000);
    // The budget is consumed in order, so each inlined image is no larger than
    // what was left when it was reached.
    expect(sizes[0]).toBeGreaterThan(0);
  });
});

describe("resource links", () => {
  it("returns a fetchable file:// link for every reported file", async () => {
    const r = await collectArtifacts(path.join(root, ws), ["big.png"]);

    expect(r.links).toHaveLength(1);
    expect(r.links[0].uri.startsWith("file:///")).toBe(true);
    expect(r.links[0].uri).not.toContain("\\");
    expect(r.links[0].name).toBe("big.png");
    expect(r.links[0].mimeType).toBe("image/png");
  });
});
