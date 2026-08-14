import type { ConfigContext, ExpoConfig } from 'expo/config';
import mobilePackage from './package.json';

import { resolvePublicEnvironment } from './src/config/public-environment.cjs';

// Expo transpiles app.config.ts in isolation, so build-time constants stay here.
const SUPPORTED_LOCALES = [
  'ko',
  'en',
  'ja',
  'zh-Hans',
  'zh-Hant',
  'vi',
] as const;
const ANDROID_FOREGROUND_LOCATION_PERMISSIONS = [
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
] as const;
const BLOCKED_ANDROID_PERMISSIONS = [
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
const PUBLIC_BUILD_BLOCKED_ANDROID_PERMISSIONS = [
  'android.permission.SYSTEM_ALERT_WINDOW',
] as const;
const FOREGROUND_LOCATION_DISCLOSURE =
  '다녀담은 사용자가 카드 획득을 시도할 때만 현재 위치를 확인합니다.';

export default ({ config }: ConfigContext): ExpoConfig => {
  const publicEnvironment = resolvePublicEnvironment({
    APP_ENV: process.env.APP_ENV,
    EXPO_PUBLIC_API_BASE_URL: process.env.EXPO_PUBLIC_API_BASE_URL,
    EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS:
      process.env.EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS,
  });
  const isLocalBuild =
    publicEnvironment.appEnvironment === 'development' ||
    publicEnvironment.appEnvironment === 'e2e';
  const buildSourceCommitSha =
    process.env.EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA ?? null;
  if (
    (process.env.EAS_BUILD === 'true' ||
      process.env.EAS_BUILD_PROFILE === 'production') &&
    publicEnvironment.appEnvironment === 'production' &&
    !/^[a-f0-9]{40}$/.test(buildSourceCommitSha ?? '')
  ) {
    throw new Error(
      'Production EAS builds require EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA from the verified pre-install gate.',
    );
  }
  const appTransportSecurity = isLocalBuild
    ? {
        NSAllowsArbitraryLoads: false,
        NSAllowsLocalNetworking: true,
        NSExceptionDomains: {
          localhost: {
            NSExceptionAllowsInsecureHTTPLoads: true,
            NSIncludesSubdomains: true,
          },
          '127.0.0.1': {
            NSExceptionAllowsInsecureHTTPLoads: true,
          },
        },
      }
    : {
        NSAllowsArbitraryLoads: false,
      };
  const baseExtra = { ...config.extra };
  delete baseExtra.buildSourceCommitSha;
  delete baseExtra.expectedServerBonusPackIssuanceScope;
  delete baseExtra.mobilePublicConfigSha256;
  delete baseExtra.BONUS_PACK_ISSUANCE_SCOPE;

  return {
    ...config,
    name: '다녀담',
    slug: 'danyeodam',
    version: mobilePackage.version,
    orientation: 'portrait',
    scheme: 'danyeodam',
    userInterfaceStyle: 'automatic',
    icon: './assets/images/icon.png',
    locales: {
      ko: './locales/ko.json',
      en: './locales/en.json',
      ja: './locales/ja.json',
      'zh-Hans': './locales/zh-Hans.json',
      'zh-Hant': './locales/zh-Hant.json',
      vi: './locales/vi.json',
    },
    ios: {
      bundleIdentifier: 'kr.danyeodam.app',
      buildNumber: '1',
      supportsTablet: false,
      config: {
        usesNonExemptEncryption: false,
      },
      infoPlist: {
        CFBundleAllowMixedLocalizations: true,
        NSAppTransportSecurity: appTransportSecurity,
        NSLocationWhenInUseUsageDescription: FOREGROUND_LOCATION_DISCLOSURE,
      },
    },
    android: {
      package: 'kr.danyeodam.app',
      versionCode: 1,
      allowBackup: false,
      predictiveBackGestureEnabled: false,
      permissions: [...ANDROID_FOREGROUND_LOCATION_PERMISSIONS],
      blockedPermissions: [
        ...BLOCKED_ANDROID_PERMISSIONS,
        ...(!isLocalBuild ? PUBLIC_BUILD_BLOCKED_ANDROID_PERMISSIONS : []),
      ],
      adaptiveIcon: {
        backgroundColor: '#F8F4EA',
        foregroundImage: './assets/images/android-icon-foreground.png',
      },
    },
    web: {
      output: 'static',
      favicon: './assets/images/favicon.png',
    },
    plugins: [
      'expo-router',
      [
        'expo-build-properties',
        {
          ios: {
            deploymentTarget: '16.4',
          },
          android: {
            minSdkVersion: 24,
            compileSdkVersion: 36,
            targetSdkVersion: 36,
            usesCleartextTraffic: isLocalBuild,
          },
        },
      ],
      [
        'expo-localization',
        {
          supportedLocales: {
            ios: [...SUPPORTED_LOCALES],
            android: [...SUPPORTED_LOCALES],
          },
        },
      ],
      [
        'expo-location',
        {
          locationAlwaysAndWhenInUsePermission: false,
          locationAlwaysPermission: false,
          locationWhenInUsePermission: FOREGROUND_LOCATION_DISCLOSURE,
          motionUsagePermission: false,
          isIosBackgroundLocationEnabled: false,
          isAndroidBackgroundLocationEnabled: false,
          isAndroidForegroundServiceEnabled: false,
          isAndroidMotionActivityEnabled: false,
        },
      ],
      [
        'expo-image-picker',
        {
          photosPermission: false,
          cameraPermission: false,
          microphonePermission: false,
        },
      ],
      [
        'expo-splash-screen',
        {
          backgroundColor: '#F8F4EA',
          android: {
            image: './assets/images/android-icon-foreground.png',
            imageWidth: 160,
            resizeMode: 'contain',
          },
        },
      ],
      [
        'expo-secure-store',
        {
          configureAndroidBackup: false,
          faceIDPermission: false,
        },
      ],
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
    extra: {
      ...baseExtra,
      ...publicEnvironment,
      ...(buildSourceCommitSha === null ? {} : { buildSourceCommitSha }),
    },
  };
};
