import {
  MAX_PERSONAL_CARD_SOURCE_BYTES,
  type PersonalCardContentType,
} from '@/api/personal-card-photo';
import type { SystemImagePickerResult } from '@/platform/system-image-picker';

const LOCAL_IMAGE_SCHEMES = new Set(['blob:', 'content:', 'file:', 'ph:']);

export const PERSONAL_CARD_MAX_DIMENSION = 2_048;
export const PERSONAL_CARD_JPEG_QUALITY = 0.85;

export type SelectedPersonalCardPhoto = {
  bytes: Uint8Array;
  contentType: PersonalCardContentType;
  sizeBytes: number;
};

export type PersonalCardResize =
  | null
  | { width: number }
  | { height: number };

export type SanitizedPersonalCardPhoto = {
  bytes: Uint8Array;
  contentType: 'image/jpeg';
  height: number;
  width: number;
};

export class PersonalCardSelectionError extends Error {
  readonly reason:
    | 'ABORTED'
    | 'READ_FAILED'
    | 'TOO_LARGE'
    | 'UNSUPPORTED_TYPE';

  constructor(reason: PersonalCardSelectionError['reason']) {
    super(`Personal card selection failed with ${reason}.`);
    this.name = 'PersonalCardSelectionError';
    this.reason = reason;
  }
}

export function detectSelectedPersonalCardContentType(
  bytes: Uint8Array,
): PersonalCardContentType | null {
  if (
    bytes.byteLength >= 3
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    bytes.byteLength >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.byteLength >= 12
    && bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

function validateDimension(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
    throw new PersonalCardSelectionError('UNSUPPORTED_TYPE');
  }
  return value;
}

export function personalCardResize(
  widthInput: number,
  heightInput: number,
): PersonalCardResize {
  const width = validateDimension(widthInput);
  const height = validateDimension(heightInput);
  if (width <= PERSONAL_CARD_MAX_DIMENSION && height <= PERSONAL_CARD_MAX_DIMENSION) {
    return null;
  }
  return width >= height
    ? { width: PERSONAL_CARD_MAX_DIMENSION }
    : { height: PERSONAL_CARD_MAX_DIMENSION };
}

function validateLocalAssetUri(uri: string): string {
  try {
    const parsed = new URL(uri);
    if (!LOCAL_IMAGE_SCHEMES.has(parsed.protocol)) {
      throw new PersonalCardSelectionError('READ_FAILED');
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof PersonalCardSelectionError) {
      throw error;
    }
    throw new PersonalCardSelectionError('READ_FAILED');
  }
}

type SelectedAsset = NonNullable<SystemImagePickerResult['assets']>[number];

function onlySelectedAsset(result: SystemImagePickerResult): SelectedAsset | null {
  if (result.canceled) {
    return null;
  }
  if (result.assets.length !== 1 || result.assets[0]?.type === 'video') {
    throw new PersonalCardSelectionError('UNSUPPORTED_TYPE');
  }
  return result.assets[0] ?? null;
}

function validateSanitizedPhoto(
  photo: SanitizedPersonalCardPhoto,
): SelectedPersonalCardPhoto {
  if (
    detectSelectedPersonalCardContentType(photo.bytes) !== 'image/jpeg'
    || photo.contentType !== 'image/jpeg'
    || photo.bytes.byteLength < 1
    || photo.bytes.byteLength > MAX_PERSONAL_CARD_SOURCE_BYTES
    || !Number.isSafeInteger(photo.width)
    || !Number.isSafeInteger(photo.height)
    || photo.width < 1
    || photo.height < 1
    || photo.width > PERSONAL_CARD_MAX_DIMENSION
    || photo.height > PERSONAL_CARD_MAX_DIMENSION
  ) {
    throw new PersonalCardSelectionError(
      photo.bytes.byteLength > MAX_PERSONAL_CARD_SOURCE_BYTES
        ? 'TOO_LARGE'
        : 'UNSUPPORTED_TYPE',
    );
  }
  return {
    bytes: photo.bytes,
    contentType: 'image/jpeg',
    sizeBytes: photo.bytes.byteLength,
  };
}

export async function selectPersonalCardPhoto(
  dependencies: {
    pick(): Promise<SystemImagePickerResult>;
    releaseRawAsset?(uri: string): Promise<void> | void;
    sanitize(input: {
      uri: string;
      resize: PersonalCardResize;
      signal: AbortSignal;
    }): Promise<SanitizedPersonalCardPhoto>;
  },
  signal: AbortSignal,
): Promise<SelectedPersonalCardPhoto | null> {
  if (signal.aborted) {
    throw new PersonalCardSelectionError('ABORTED');
  }
  let result: SystemImagePickerResult;
  try {
    result = await dependencies.pick();
  } catch {
    throw new PersonalCardSelectionError('READ_FAILED');
  }
  const rawAssetUris = result.assets?.flatMap((asset) => (
    typeof asset.uri === 'string' ? [asset.uri] : []
  )) ?? [];
  let sanitized: SanitizedPersonalCardPhoto | null = null;
  try {
    const asset = onlySelectedAsset(result);
    if (signal.aborted) {
      throw new PersonalCardSelectionError('ABORTED');
    }
    if (asset === null) {
      return null;
    }
    if (
      asset.fileSize !== undefined
      && (!Number.isSafeInteger(asset.fileSize) || asset.fileSize < 1)
    ) {
      throw new PersonalCardSelectionError('READ_FAILED');
    }
    // Keep an early bound before decoding, but never upload this raw source.
    if ((asset.fileSize ?? 0) > MAX_PERSONAL_CARD_SOURCE_BYTES) {
      throw new PersonalCardSelectionError('TOO_LARGE');
    }

    const uri = validateLocalAssetUri(asset.uri);
    const resize = personalCardResize(asset.width, asset.height);
    try {
      sanitized = await dependencies.sanitize({ uri, resize, signal });
    } catch (error) {
      if (error instanceof PersonalCardSelectionError) {
        throw error;
      }
      throw new PersonalCardSelectionError(
        signal.aborted ? 'ABORTED' : 'READ_FAILED',
      );
    }
    if (signal.aborted) {
      sanitized.bytes.fill(0);
      throw new PersonalCardSelectionError('ABORTED');
    }
    try {
      return validateSanitizedPhoto(sanitized);
    } catch (error) {
      sanitized.bytes.fill(0);
      throw error;
    }
  } finally {
    try {
      for (const uri of rawAssetUris) {
        await dependencies.releaseRawAsset?.(uri);
      }
    } catch {
      sanitized?.bytes.fill(0);
      throw new PersonalCardSelectionError('READ_FAILED');
    }
  }
}
