import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { getReviewerSampleImage } from "@/server/reviewer-access/sample-image";

describe("reviewer rights-safe sample image", () => {
  it("is stable, bounded, WebP, and carries no metadata", async () => {
    const first = await getReviewerSampleImage();
    const second = await getReviewerSampleImage();
    const metadata = await sharp(first.bytes).metadata();

    expect(second.sha256Hex).toBe(first.sha256Hex);
    expect(second.sizeBytes).toBe(first.sizeBytes);
    expect(first.sha256Hex).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.sizeBytes).toBeGreaterThan(0);
    expect(first.sizeBytes).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(1500);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
  });
});
