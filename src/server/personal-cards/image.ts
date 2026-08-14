import "server-only";

import sharp from "sharp";

import {
  MAX_PERSONAL_CARD_SOURCE_BYTES,
  type PersonalCardContentType,
} from "@/server/personal-cards/input";

const MAX_INPUT_PIXELS = 40_000_000;
const MAX_INPUT_DIMENSION = 16_384;
const MAX_OUTPUT_DIMENSION = 2_048;
export const MAX_PERSONAL_CARD_DERIVED_BYTES = 5 * 1024 * 1024;

export class PersonalCardImageValidationError extends Error {
  constructor() {
    super("Personal card image validation failed");
    this.name = "PersonalCardImageValidationError";
  }
}

function hasBytes(bytes: Uint8Array, offset: number, expected: number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

export function detectPersonalCardContentType(
  bytes: Uint8Array,
): PersonalCardContentType | undefined {
  if (bytes.length >= 3 && hasBytes(bytes, 0, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8
    && hasBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12
    && hasBytes(bytes, 0, [0x52, 0x49, 0x46, 0x46])
    && hasBytes(bytes, 8, [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp";
  }
  return undefined;
}

function reject(): never {
  throw new PersonalCardImageValidationError();
}

export async function validateAndDerivePersonalCardImage(input: {
  bytes: Uint8Array;
  declaredContentType: PersonalCardContentType;
  declaredSizeBytes: number;
}): Promise<Uint8Array> {
  if (
    input.bytes.byteLength === 0
    || input.bytes.byteLength > MAX_PERSONAL_CARD_SOURCE_BYTES
    || input.bytes.byteLength !== input.declaredSizeBytes
    || detectPersonalCardContentType(input.bytes) !== input.declaredContentType
  ) {
    reject();
  }

  const source = Buffer.from(
    input.bytes.buffer,
    input.bytes.byteOffset,
    input.bytes.byteLength,
  );

  try {
    const metadata = await sharp(source, {
      animated: true,
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
      sequentialRead: true,
    }).metadata();

    if (
      metadata.format === undefined
      || metadata.mediaType !== input.declaredContentType
      || metadata.width === undefined
      || metadata.height === undefined
      || metadata.width < 1
      || metadata.height < 1
      || metadata.width > MAX_INPUT_DIMENSION
      || metadata.height > MAX_INPUT_DIMENSION
      || (metadata.pages ?? 1) !== 1
    ) {
      reject();
    }

    const output = await sharp(source, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
      sequentialRead: true,
    })
      .rotate()
      .resize({
        width: MAX_OUTPUT_DIMENSION,
        height: MAX_OUTPUT_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({
        effort: 4,
        quality: 85,
        smartSubsample: true,
      })
      .toBuffer();

    if (output.byteLength === 0 || output.byteLength > MAX_PERSONAL_CARD_DERIVED_BYTES) {
      reject();
    }

    return new Uint8Array(output);
  } catch (error) {
    if (error instanceof PersonalCardImageValidationError) {
      throw error;
    }
    throw new PersonalCardImageValidationError();
  }
}
