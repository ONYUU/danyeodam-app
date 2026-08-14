import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  detectPersonalCardContentType,
  MAX_PERSONAL_CARD_DERIVED_BYTES,
  PersonalCardImageValidationError,
  validateAndDerivePersonalCardImage,
} from "@/server/personal-cards/image";
import { MAX_PERSONAL_CARD_SOURCE_BYTES } from "@/server/personal-cards/input";

async function makeJpegWithExif(): Promise<Buffer> {
  return sharp({
    create: {
      width: 3_000,
      height: 1_000,
      channels: 3,
      background: "#d97706",
    },
  })
    .withMetadata({
      orientation: 6,
      exif: {
        IFD0: {
          Copyright: "must-not-survive",
        },
      },
    })
    .jpeg({ quality: 80 })
    .toBuffer();
}

describe("personal card image security boundary", () => {
  it("detects only JPEG, PNG, and WebP magic bytes", () => {
    expect(detectPersonalCardContentType(Uint8Array.from([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
    expect(detectPersonalCardContentType(Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]))).toBe("image/png");
    expect(detectPersonalCardContentType(Buffer.from("RIFFxxxxWEBP", "ascii"))).toBe("image/webp");
    expect(detectPersonalCardContentType(Buffer.from("GIF89a", "ascii"))).toBeUndefined();
  });

  it("auto-orients, limits dimensions, re-encodes to WebP, and strips EXIF", async () => {
    const source = await makeJpegWithExif();
    expect((await sharp(source).metadata()).exif).toBeDefined();

    const output = await validateAndDerivePersonalCardImage({
      bytes: source,
      declaredContentType: "image/jpeg",
      declaredSizeBytes: source.byteLength,
    });
    const metadata = await sharp(output).metadata();

    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBeLessThanOrEqual(2_048);
    expect(metadata.height).toBeLessThanOrEqual(2_048);
    expect(metadata.exif).toBeUndefined();
    expect(Buffer.from(output).includes(Buffer.from("must-not-survive"))).toBe(false);
    expect(output.byteLength).toBeLessThanOrEqual(MAX_PERSONAL_CARD_DERIVED_BYTES);
  });

  it("rejects MIME mismatch and declared-size mismatch", async () => {
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "white" },
    }).png().toBuffer();

    await expect(validateAndDerivePersonalCardImage({
      bytes: png,
      declaredContentType: "image/jpeg",
      declaredSizeBytes: png.byteLength,
    })).rejects.toBeInstanceOf(PersonalCardImageValidationError);
    await expect(validateAndDerivePersonalCardImage({
      bytes: png,
      declaredContentType: "image/png",
      declaredSizeBytes: png.byteLength + 1,
    })).rejects.toBeInstanceOf(PersonalCardImageValidationError);
  });

  it("rejects an oversized source before decoding", async () => {
    const oversized = new Uint8Array(MAX_PERSONAL_CARD_SOURCE_BYTES + 1);
    oversized.set([0xff, 0xd8, 0xff]);

    await expect(validateAndDerivePersonalCardImage({
      bytes: oversized,
      declaredContentType: "image/jpeg",
      declaredSizeBytes: oversized.byteLength,
    })).rejects.toBeInstanceOf(PersonalCardImageValidationError);
  });

  it("rejects malformed content even when its magic bytes look valid", async () => {
    const malformed = Buffer.from("RIFF\x10\x00\x00\x00WEBPnot-an-image", "binary");

    await expect(validateAndDerivePersonalCardImage({
      bytes: malformed,
      declaredContentType: "image/webp",
      declaredSizeBytes: malformed.byteLength,
    })).rejects.toBeInstanceOf(PersonalCardImageValidationError);
  });

  it("rejects animated WebP rather than silently taking one frame", async () => {
    const animatedWebp = Buffer.from(
      "UklGRpQAAABXRUJQVlA4WAoAAAACAAAAAAAAAAAAQU5JTQYAAAD/////AQBBTk1GMAAAAAAAAAAAAAAAAAAAAGQAAAJWUDggGAAAADABAJ0BKgEAAQABQCYlpAADcAD+/TZoAEFOTUYwAAAAAAAAAAAAAAAAAAAAZAAAAFZQOCAYAAAANAEAnQEqAQABAAAAJiWkAANwAP789AAA",
      "base64",
    );
    expect((await sharp(animatedWebp, { animated: true }).metadata()).pages).toBe(2);

    await expect(validateAndDerivePersonalCardImage({
      bytes: animatedWebp,
      declaredContentType: "image/webp",
      declaredSizeBytes: animatedWebp.byteLength,
    })).rejects.toBeInstanceOf(PersonalCardImageValidationError);
  });
});
