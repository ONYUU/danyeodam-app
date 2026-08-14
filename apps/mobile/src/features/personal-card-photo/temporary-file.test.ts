import { describe, expect, it, vi } from 'vitest';

import { readTemporaryImageBytesAndDelete } from './temporary-file';

describe('temporary re-encoded image cleanup', () => {
  it('deletes the cache file after reading bytes', async () => {
    const bytes = new Uint8Array<ArrayBuffer>(new Uint8Array([1, 2, 3]).buffer);
    const file = {
      bytes: vi.fn(async () => bytes),
      delete: vi.fn(),
      exists: true,
    };
    await expect(readTemporaryImageBytesAndDelete(file)).resolves.toBe(bytes);
    expect(file.delete).toHaveBeenCalledOnce();
  });

  it('deletes the cache file even when reading fails', async () => {
    const file = {
      bytes: vi.fn(async () => { throw new Error('read failed'); }),
      delete: vi.fn(),
      exists: true,
    };
    await expect(readTemporaryImageBytesAndDelete(file)).rejects.toThrow('read failed');
    expect(file.delete).toHaveBeenCalledOnce();
  });
});
