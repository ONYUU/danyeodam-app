import { describe, expect, it, vi } from 'vitest';

import {
  closeNativeBlobIfSupported,
  createOwnedPhotoResource,
  releaseOwnedPhotoResource,
} from './owned-photo-resource';

describe('owned native photo resource', () => {
  it('creates and revokes the exact object URL and closes an RN-compatible Blob', () => {
    const close = vi.fn();
    const blob = Object.assign(
      new Blob([new Uint8Array([1])], { type: 'image/webp' }),
      { close },
    );
    const create = vi.fn(() => 'blob:native-photo');
    const revoke = vi.fn();

    const resource = createOwnedPhotoResource(blob, create);
    expect(resource).toEqual({ blob, objectUrl: 'blob:native-photo' });
    releaseOwnedPhotoResource(resource, revoke);
    expect(create).toHaveBeenCalledWith(blob);
    expect(revoke).toHaveBeenCalledWith('blob:native-photo');
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes an unpublished native Blob if object URL creation fails', () => {
    const close = vi.fn();
    const blob = Object.assign(new Blob(), { close });

    expect(() => createOwnedPhotoResource(blob, () => {
      throw new Error('object URL failed');
    })).toThrow('object URL failed');
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not require close on a standard web Blob', () => {
    expect(() => closeNativeBlobIfSupported(new Blob())).not.toThrow();
  });
});
