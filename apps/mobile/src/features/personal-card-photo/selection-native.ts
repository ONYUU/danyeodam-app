import { File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { pickSingleImageFromSystemLibrary } from '@/platform/system-image-picker';

import { reencodePersonalCardPhoto } from './reencode';
import { deleteOwnedImagePickerCacheFile } from './picker-cache-file';
import { selectPersonalCardPhoto } from './selection';
import { readTemporaryImageBytesAndDelete } from './temporary-file';

export function selectPersonalCardPhotoFromSystem(signal: AbortSignal) {
  return selectPersonalCardPhoto({
    pick: pickSingleImageFromSystemLibrary,
    releaseRawAsset: (uri) => {
      deleteOwnedImagePickerCacheFile(
        { cacheUri: Paths.cache.uri, uri },
        (candidate) => new File(candidate),
      );
    },
    sanitize: (input) => reencodePersonalCardPhoto(input, {
      jpegFormat: SaveFormat.JPEG,
      manipulate: (uri) => ImageManipulator.manipulate(uri),
      readAndDelete: (uri) => readTemporaryImageBytesAndDelete(new File(uri)),
    }),
  }, signal);
}
