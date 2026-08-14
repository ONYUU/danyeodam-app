import { describe, expect, it, vi } from 'vitest';

import { MAX_PERSONAL_CARD_SOURCE_BYTES } from '@/api/personal-card-photo';
import type { SystemImagePickerResult } from '@/platform/system-image-picker';

import {
  detectSelectedPersonalCardContentType,
  PERSONAL_CARD_MAX_DIMENSION,
  personalCardResize,
  PersonalCardSelectionError,
  selectPersonalCardPhoto,
} from './selection';

function selected(overrides: Record<string, unknown> = {}): SystemImagePickerResult {
  return {
    canceled: false,
    assets: [{
      assetId: null,
      base64: null,
      duration: null,
      exif: null,
      fileName: 'photo.heic',
      fileSize: 2_000_000,
      height: 3_000,
      mimeType: 'image/heic',
      pairedVideoAsset: null,
      type: 'image',
      uri: 'file:///private/photo.heic',
      width: 4_000,
      ...overrides,
    }],
  } as SystemImagePickerResult;
}

const sanitizedJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0]);

describe('personal-card system photo selection', () => {
  it('detects supported formats from bytes rather than picker metadata', () => {
    expect(detectSelectedPersonalCardContentType(
      new Uint8Array([0xff, 0xd8, 0xff]),
    )).toBe('image/jpeg');
    expect(detectSelectedPersonalCardContentType(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )).toBe('image/png');
    expect(detectSelectedPersonalCardContentType(
      new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
    )).toBe('image/webp');
    expect(detectSelectedPersonalCardContentType(
      new TextEncoder().encode('not-an-image'),
    )).toBeNull();
  });

  it('calculates a longest-edge-only resize without enlarging small images', () => {
    expect(personalCardResize(4_000, 3_000)).toEqual({ width: 2_048 });
    expect(personalCardResize(3_000, 4_000)).toEqual({ height: 2_048 });
    expect(personalCardResize(2_048, 1_024)).toBeNull();
    expect(personalCardResize(1_024, 2_048)).toBeNull();
    expect(() => personalCardResize(0, 100)).toThrow(PersonalCardSelectionError);
  });

  it('returns only the sanitized JPEG bytes and never reads raw picker bytes', async () => {
    const releaseRawAsset = vi.fn();
    const sanitize = vi.fn(async () => ({
      bytes: sanitizedJpeg.slice(),
      contentType: 'image/jpeg' as const,
      width: PERSONAL_CARD_MAX_DIMENSION,
      height: 1_536,
    }));
    await expect(selectPersonalCardPhoto({
      pick: async () => selected(),
      releaseRawAsset,
      sanitize,
    }, new AbortController().signal)).resolves.toEqual({
      bytes: sanitizedJpeg,
      contentType: 'image/jpeg',
      sizeBytes: sanitizedJpeg.byteLength,
    });
    expect(sanitize).toHaveBeenCalledWith({
      uri: 'file:///private/photo.heic',
      resize: { width: 2_048 },
      signal: expect.any(AbortSignal),
    });
    expect(releaseRawAsset).toHaveBeenCalledWith('file:///private/photo.heic');
  });

  it('treats system picker cancellation as a neutral result', async () => {
    const sanitize = vi.fn();
    await expect(selectPersonalCardPhoto({
      pick: async () => ({ canceled: true, assets: null }),
      sanitize,
    }, new AbortController().signal)).resolves.toBeNull();
    expect(sanitize).not.toHaveBeenCalled();
  });

  it('rejects remote URIs and oversized raw files before decoding them', async () => {
    const sanitize = vi.fn();
    await expect(selectPersonalCardPhoto({
      pick: async () => selected({ uri: 'https://attacker.invalid/photo.jpg' }),
      sanitize,
    }, new AbortController().signal)).rejects.toBeInstanceOf(PersonalCardSelectionError);
    await expect(selectPersonalCardPhoto({
      pick: async () => selected({ fileSize: MAX_PERSONAL_CARD_SOURCE_BYTES + 1 }),
      sanitize,
    }, new AbortController().signal)).rejects.toMatchObject({ reason: 'TOO_LARGE' });
    expect(sanitize).not.toHaveBeenCalled();
  });

  it('rejects output that is not a bounded re-encoded JPEG', async () => {
    const invalidBytes = new TextEncoder().encode('ftypheic');
    await expect(selectPersonalCardPhoto({
      pick: async () => selected(),
      sanitize: async () => ({
        bytes: invalidBytes,
        contentType: 'image/jpeg',
        width: 2_048,
        height: 1_536,
      }),
    }, new AbortController().signal)).rejects.toMatchObject({
      reason: 'UNSUPPORTED_TYPE',
    });
    expect(invalidBytes).toEqual(new Uint8Array(invalidBytes.byteLength));
    const oversizedDimensionBytes = sanitizedJpeg.slice();
    await expect(selectPersonalCardPhoto({
      pick: async () => selected(),
      sanitize: async () => ({
        bytes: oversizedDimensionBytes,
        contentType: 'image/jpeg',
        width: 2_049,
        height: 1_536,
      }),
    }, new AbortController().signal)).rejects.toMatchObject({
      reason: 'UNSUPPORTED_TYPE',
    });
    expect(oversizedDimensionBytes).toEqual(
      new Uint8Array(oversizedDimensionBytes.byteLength),
    );
  });

  it.each([
    ['sanitize failure', selected(), new Error('decode failed')],
    ['oversized input', selected({ fileSize: MAX_PERSONAL_CARD_SOURCE_BYTES + 1 }), null],
  ])('deletes the raw picker cache after %s', async (_label, pickResult, sanitizeError) => {
    const releaseRawAsset = vi.fn();
    await expect(selectPersonalCardPhoto({
      pick: async () => pickResult,
      releaseRawAsset,
      sanitize: async () => {
        throw sanitizeError ?? new Error('sanitize must not run');
      },
    }, new AbortController().signal)).rejects.toBeInstanceOf(PersonalCardSelectionError);
    expect(releaseRawAsset).toHaveBeenCalledWith('file:///private/photo.heic');
  });

  it('wipes sanitized bytes and deletes the raw picker cache when aborted', async () => {
    const controller = new AbortController();
    const bytes = sanitizedJpeg.slice();
    const releaseRawAsset = vi.fn();

    await expect(selectPersonalCardPhoto({
      pick: async () => selected(),
      releaseRawAsset,
      sanitize: async () => {
        controller.abort();
        return {
          bytes,
          contentType: 'image/jpeg',
          width: 2_048,
          height: 1_536,
        };
      },
    }, controller.signal)).rejects.toMatchObject({ reason: 'ABORTED' });
    expect(bytes).toEqual(new Uint8Array(bytes.byteLength));
    expect(releaseRawAsset).toHaveBeenCalledWith('file:///private/photo.heic');
  });

  it('deletes a selected raw cache file when cancellation happens after the picker resolves', async () => {
    const controller = new AbortController();
    const releaseRawAsset = vi.fn();
    await expect(selectPersonalCardPhoto({
      pick: async () => {
        controller.abort();
        return selected();
      },
      releaseRawAsset,
      sanitize: vi.fn(),
    }, controller.signal)).rejects.toMatchObject({ reason: 'ABORTED' });
    expect(releaseRawAsset).toHaveBeenCalledWith('file:///private/photo.heic');
  });

  it('fails closed and wipes sanitized bytes if raw cache deletion fails', async () => {
    const bytes = sanitizedJpeg.slice();
    await expect(selectPersonalCardPhoto({
      pick: async () => selected(),
      releaseRawAsset: () => {
        throw new Error('delete failed');
      },
      sanitize: async () => ({
        bytes,
        contentType: 'image/jpeg',
        width: 2_048,
        height: 1_536,
      }),
    }, new AbortController().signal)).rejects.toMatchObject({ reason: 'READ_FAILED' });
    expect(bytes).toEqual(new Uint8Array(bytes.byteLength));
  });
});
