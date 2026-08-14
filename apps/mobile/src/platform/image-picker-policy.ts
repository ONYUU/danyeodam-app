import type { ImagePickerOptions } from 'expo-image-picker';

export const SYSTEM_IMAGE_PICKER_OPTIONS = {
  mediaTypes: 'images',
  allowsEditing: false,
  allowsMultipleSelection: false,
  selectionLimit: 1,
  orderedSelection: false,
  exif: false,
  base64: false,
  quality: 0.85,
  // iOS may otherwise return an HEIC original that the bounded server image
  // contract intentionally does not accept. Compatible mode asks PHPicker for
  // a JPEG-compatible representation without granting broad library access.
  preferredAssetRepresentationMode: 'compatible' as NonNullable<
    ImagePickerOptions['preferredAssetRepresentationMode']
  >,
} satisfies ImagePickerOptions;
