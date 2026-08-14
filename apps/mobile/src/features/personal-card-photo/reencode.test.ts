import { describe, expect, it, vi } from 'vitest';

import { reencodePersonalCardPhoto } from './reencode';
import { PERSONAL_CARD_JPEG_QUALITY } from './selection';

const sanitizedJpeg = new Uint8Array<ArrayBuffer>(
  new Uint8Array([0xff, 0xd8, 0xff, 0]).buffer,
);

describe('personal-card native re-encoding contract', () => {
  it('resizes, saves as non-base64 JPEG, reads the cache result, and releases native refs', async () => {
    const resize = vi.fn();
    const saveAsync = vi.fn(async () => ({
      uri: 'file:///cache/ImageManipulator/sanitized.jpg',
      width: 2_048,
      height: 1_536,
    }));
    const imageRelease = vi.fn();
    const contextRelease = vi.fn();
    const readAndDelete = vi.fn(async () => sanitizedJpeg.slice());
    const manipulate = vi.fn(() => ({
      release: contextRelease,
      resize,
      renderAsync: async () => ({ release: imageRelease, saveAsync }),
    }));

    await expect(reencodePersonalCardPhoto({
      uri: 'file:///private/raw.heic',
      resize: { width: 2_048 },
      signal: new AbortController().signal,
    }, { jpegFormat: 'jpeg' as const, manipulate, readAndDelete })).resolves.toEqual({
      bytes: sanitizedJpeg,
      contentType: 'image/jpeg',
      width: 2_048,
      height: 1_536,
    });
    expect(manipulate).toHaveBeenCalledWith('file:///private/raw.heic');
    expect(resize).toHaveBeenCalledWith({ width: 2_048 });
    expect(saveAsync).toHaveBeenCalledWith({
      base64: false,
      compress: PERSONAL_CARD_JPEG_QUALITY,
      format: 'jpeg',
    });
    expect(readAndDelete).toHaveBeenCalledWith(
      'file:///cache/ImageManipulator/sanitized.jpg',
    );
    expect(imageRelease).toHaveBeenCalledOnce();
    expect(contextRelease).toHaveBeenCalledOnce();
  });

  it('still releases the manipulation context when rendering fails', async () => {
    const contextRelease = vi.fn();
    await expect(reencodePersonalCardPhoto({
      uri: 'file:///private/raw.jpg',
      resize: null,
      signal: new AbortController().signal,
    }, {
      jpegFormat: 'jpeg' as const,
      manipulate: () => ({
        release: contextRelease,
        resize: vi.fn(),
        renderAsync: async () => { throw new Error('decode failed'); },
      }),
      readAndDelete: vi.fn(),
    })).rejects.toThrow('decode failed');
    expect(contextRelease).toHaveBeenCalledOnce();
  });
});
