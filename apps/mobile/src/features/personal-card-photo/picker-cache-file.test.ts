import { describe, expect, it, vi } from 'vitest';

import {
  deleteOwnedImagePickerCacheFile,
  isOwnedImagePickerCacheFile,
} from './picker-cache-file';

const cacheUri = 'file:///private/app/Library/Caches/';

describe('system image-picker cache ownership', () => {
  it('accepts only a direct ImagePicker child of the app cache', () => {
    expect(isOwnedImagePickerCacheFile({
      cacheUri,
      uri: `${cacheUri}ImagePicker/1234.jpeg`,
    })).toBe(true);

    for (const uri of [
      'content://media/photo/1',
      'ph://asset-id',
      'blob:native-photo',
      'file:///private/app/Documents/photo.jpeg',
      `${cacheUri}ImagePicker/nested/photo.jpeg`,
      `${cacheUri}ImagePicker/%2e%2e/secret.jpeg`,
      `${cacheUri}ImagePicker/photo.jpeg?keep=true`,
    ]) {
      expect(isOwnedImagePickerCacheFile({ cacheUri, uri })).toBe(false);
    }
  });

  it('deletes an existing owned file and ignores every unowned path', () => {
    const deleteFile = vi.fn();
    const createFile = vi.fn(() => ({ delete: deleteFile, exists: true }));

    expect(deleteOwnedImagePickerCacheFile({
      cacheUri,
      uri: `${cacheUri}ImagePicker/1234.jpeg`,
    }, createFile)).toBe(true);
    expect(deleteFile).toHaveBeenCalledOnce();

    expect(deleteOwnedImagePickerCacheFile({
      cacheUri,
      uri: 'file:///private/app/Documents/photo.jpeg',
    }, createFile)).toBe(false);
    expect(createFile).toHaveBeenCalledOnce();
  });
});
