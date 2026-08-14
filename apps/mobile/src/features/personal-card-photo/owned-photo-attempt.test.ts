import { describe, expect, it, vi } from 'vitest';

import { createOwnedPhotoLoadAttempt } from './owned-photo-attempt';

describe('owned photo load attempt', () => {
  it('closes a late native Blob after the screen has released the attempt', () => {
    const close = vi.fn();
    const blob = Object.assign(new Blob(), { close });
    const createResource = vi.fn();
    const attempt = createOwnedPhotoLoadAttempt({ createResource });

    attempt.release();

    expect(attempt.publish(blob)).toBeNull();
    expect(close).toHaveBeenCalledOnce();
    expect(createResource).not.toHaveBeenCalled();
  });

  it('keeps one owner until cleanup and then revokes and closes once', () => {
    const blob = new Blob();
    const resource = { blob, objectUrl: 'blob:private-photo' };
    const releaseResource = vi.fn();
    const attempt = createOwnedPhotoLoadAttempt({
      createResource: () => resource,
      releaseResource,
    });

    expect(attempt.publish(blob)).toBe(resource);
    attempt.release();
    attempt.release();

    expect(releaseResource).toHaveBeenCalledOnce();
    expect(releaseResource).toHaveBeenCalledWith(resource);
  });
});
