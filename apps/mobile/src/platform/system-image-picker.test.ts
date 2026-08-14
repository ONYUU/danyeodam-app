import { describe, expect, it } from 'vitest';

import { SYSTEM_IMAGE_PICKER_OPTIONS } from './image-picker-policy';

describe('system image picker policy', () => {
  it('selects one still image without broad metadata', () => {
    expect(SYSTEM_IMAGE_PICKER_OPTIONS).toMatchObject({
      mediaTypes: 'images',
      allowsEditing: false,
      allowsMultipleSelection: false,
      selectionLimit: 1,
      exif: false,
      base64: false,
      quality: 0.85,
      preferredAssetRepresentationMode: 'compatible',
    });
  });

  it('does not expose video capture or export options', () => {
    expect(SYSTEM_IMAGE_PICKER_OPTIONS).not.toHaveProperty('videoMaxDuration');
    expect(SYSTEM_IMAGE_PICKER_OPTIONS).not.toHaveProperty('videoQuality');
    expect(SYSTEM_IMAGE_PICKER_OPTIONS).not.toHaveProperty('videoExportPreset');
  });
});
