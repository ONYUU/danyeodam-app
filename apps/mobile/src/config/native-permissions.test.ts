import { describe, expect, it } from 'vitest';

import {
  ANDROID_FOREGROUND_LOCATION_PERMISSIONS,
  BLOCKED_ANDROID_PERMISSIONS,
  PUBLIC_BUILD_BLOCKED_ANDROID_PERMISSIONS,
} from './native-permissions';

describe('native permission policy', () => {
  it('allows foreground location only', () => {
    expect(ANDROID_FOREGROUND_LOCATION_PERMISSIONS).toEqual([
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.ACCESS_FINE_LOCATION',
    ]);
    expect(BLOCKED_ANDROID_PERMISSIONS).toContain(
      'android.permission.ACCESS_BACKGROUND_LOCATION',
    );
  });

  it('blocks camera, microphone, and broad media access', () => {
    expect(BLOCKED_ANDROID_PERMISSIONS).toEqual(
      expect.arrayContaining([
        'android.permission.CAMERA',
        'android.permission.RECORD_AUDIO',
        'android.permission.READ_MEDIA_IMAGES',
        'android.permission.READ_MEDIA_VIDEO',
        'android.permission.READ_MEDIA_AUDIO',
        'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
        'android.permission.ACCESS_MEDIA_LOCATION',
        'android.permission.READ_EXTERNAL_STORAGE',
      ]),
    );
  });

  it('blocks motion and public-build overlays', () => {
    expect(BLOCKED_ANDROID_PERMISSIONS).toEqual(
      expect.arrayContaining([
        'android.permission.ACTIVITY_RECOGNITION',
        'com.google.android.gms.permission.ACTIVITY_RECOGNITION',
      ]),
    );
    expect(PUBLIC_BUILD_BLOCKED_ANDROID_PERMISSIONS).toEqual([
      'android.permission.SYSTEM_ALERT_WINDOW',
    ]);
  });
});
