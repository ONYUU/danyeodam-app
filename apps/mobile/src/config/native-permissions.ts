export const ANDROID_FOREGROUND_LOCATION_PERMISSIONS = [
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
] as const;

export const BLOCKED_ANDROID_PERMISSIONS = [
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.ACTIVITY_RECOGNITION',
  'com.google.android.gms.permission.ACTIVITY_RECOGNITION',
  'android.permission.CAMERA',
  'android.permission.RECORD_AUDIO',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_AUDIO',
  'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
  'android.permission.ACCESS_MEDIA_LOCATION',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
] as const;

export const PUBLIC_BUILD_BLOCKED_ANDROID_PERMISSIONS = [
  'android.permission.SYSTEM_ALERT_WINDOW',
] as const;

export const FOREGROUND_LOCATION_DISCLOSURE =
  '다녀담은 사용자가 카드 획득을 시도할 때만 현재 위치를 확인합니다.';
