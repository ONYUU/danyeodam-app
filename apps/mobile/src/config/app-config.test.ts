import type { ConfigContext, ExpoConfig } from 'expo/config';
import { afterEach, describe, expect, it } from 'vitest';

import createExpoConfig from '../../app.config';

const originalAppEnvironment = process.env.APP_ENV;
const originalApiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
const originalSupabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const originalSupabasePublishableKey =
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const originalPolicyAllowedOrigins =
  process.env.EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS;
const originalEasBuild = process.env.EAS_BUILD;
const originalEasBuildProfile = process.env.EAS_BUILD_PROFILE;
const originalBuildSourceCommitSha =
  process.env.EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA;

function setPublicSupabaseTestEnvironment() {
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY =
    'sb_publishable_F9x7K2mP4qR8sT6vW3yZ5aBcD1eG0hJ';
  process.env.EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS =
    'https://policies.release-fixture.danyeodam.app,https://support.release-fixture.danyeodam.app';
}

function restoreEnvironment() {
  if (originalAppEnvironment === undefined) {
    delete process.env.APP_ENV;
  } else {
    process.env.APP_ENV = originalAppEnvironment;
  }

  if (originalApiBaseUrl === undefined) {
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
  } else {
    process.env.EXPO_PUBLIC_API_BASE_URL = originalApiBaseUrl;
  }

  if (originalSupabaseUrl === undefined) {
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
  } else {
    process.env.EXPO_PUBLIC_SUPABASE_URL = originalSupabaseUrl;
  }
  if (originalSupabasePublishableKey === undefined) {
    delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  } else {
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY =
      originalSupabasePublishableKey;
  }
  if (originalPolicyAllowedOrigins === undefined) {
    delete process.env.EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS;
  } else {
    process.env.EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS = originalPolicyAllowedOrigins;
  }
  if (originalEasBuild === undefined) {
    delete process.env.EAS_BUILD;
  } else {
    process.env.EAS_BUILD = originalEasBuild;
  }
  if (originalEasBuildProfile === undefined) {
    delete process.env.EAS_BUILD_PROFILE;
  } else {
    process.env.EAS_BUILD_PROFILE = originalEasBuildProfile;
  }
  if (originalBuildSourceCommitSha === undefined) {
    delete process.env.EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA;
  } else {
    process.env.EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA =
      originalBuildSourceCommitSha;
  }
}

function readConfig(): ExpoConfig {
  return createExpoConfig({ config: {} } as ConfigContext);
}

function findPlugin(config: ExpoConfig, name: string) {
  return config.plugins?.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === name,
  );
}

afterEach(restoreEnvironment);

describe('Expo application config', () => {
  it('uses the approved identity and foreground-only Android permissions', () => {
    process.env.APP_ENV = 'development';
    delete process.env.EXPO_PUBLIC_API_BASE_URL;

    const config = readConfig();

    expect(config.name).toBe('다녀담');
    expect(config.scheme).toBe('danyeodam');
    expect(config.ios?.bundleIdentifier).toBe('kr.danyeodam.app');
    expect(config.android?.package).toBe('kr.danyeodam.app');
    expect(config.android?.permissions).toEqual([
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.ACCESS_FINE_LOCATION',
    ]);
    expect(config.android?.blockedPermissions).toEqual(
      expect.arrayContaining([
        'android.permission.ACCESS_BACKGROUND_LOCATION',
        'android.permission.CAMERA',
        'android.permission.RECORD_AUDIO',
        'android.permission.READ_MEDIA_IMAGES',
        'android.permission.ACTIVITY_RECOGNITION',
      ]),
    );
    expect(config.android?.blockedPermissions).not.toContain(
      'android.permission.SYSTEM_ALERT_WINDOW',
    );
    expect(config.ios?.infoPlist).not.toHaveProperty('NSCameraUsageDescription');
    expect(config.ios?.infoPlist).not.toHaveProperty(
      'NSMicrophoneUsageDescription',
    );
    expect(config.ios?.infoPlist).not.toHaveProperty('UIBackgroundModes');
    expect(config.ios?.infoPlist).not.toHaveProperty(
      'NSPhotoLibraryUsageDescription',
    );
    expect(config.ios?.infoPlist?.NSAppTransportSecurity).toMatchObject({
      NSAllowsArbitraryLoads: false,
      NSAllowsLocalNetworking: true,
    });

    expect(findPlugin(config, 'expo-location')).toEqual([
      'expo-location',
      expect.objectContaining({
        locationAlwaysAndWhenInUsePermission: false,
        locationAlwaysPermission: false,
        motionUsagePermission: false,
        isIosBackgroundLocationEnabled: false,
        isAndroidBackgroundLocationEnabled: false,
        isAndroidForegroundServiceEnabled: false,
        isAndroidMotionActivityEnabled: false,
      }),
    ]);
    expect(findPlugin(config, 'expo-image-picker')).toEqual([
      'expo-image-picker',
      {
        photosPermission: false,
        cameraPermission: false,
        microphonePermission: false,
      },
    ]);
    expect(findPlugin(config, 'expo-splash-screen')).toEqual([
      'expo-splash-screen',
      {
        backgroundColor: '#F8F4EA',
        android: {
          image: './assets/images/android-icon-foreground.png',
          imageWidth: 160,
          resizeMode: 'contain',
        },
      },
    ]);
    expect(findPlugin(config, 'expo-build-properties')).toEqual([
      'expo-build-properties',
      expect.objectContaining({
        android: expect.objectContaining({ usesCleartextTraffic: true }),
      }),
    ]);
    expect(findPlugin(config, 'expo-secure-store')).toEqual([
      'expo-secure-store',
      {
        configureAndroidBackup: false,
        faceIDPermission: false,
      },
    ]);
  });

  it('declares all six supported locales', () => {
    process.env.APP_ENV = 'development';

    const config = readConfig();
    const localizationPlugin = findPlugin(config, 'expo-localization');

    expect(localizationPlugin).toEqual([
      'expo-localization',
      {
        supportedLocales: {
          ios: ['ko', 'en', 'ja', 'zh-Hans', 'zh-Hant', 'vi'],
          android: ['ko', 'en', 'ja', 'zh-Hans', 'zh-Hant', 'vi'],
        },
      },
    ]);
    expect(config.locales).toEqual({
      ko: './locales/ko.json',
      en: './locales/en.json',
      ja: './locales/ja.json',
      'zh-Hans': './locales/zh-Hans.json',
      'zh-Hant': './locales/zh-Hant.json',
      vi: './locales/vi.json',
    });
    expect(config.ios?.infoPlist?.CFBundleAllowMixedLocalizations).toBe(true);
  });

  it('fails closed when a production API endpoint is absent', () => {
    process.env.APP_ENV = 'production';
    delete process.env.EXPO_PUBLIC_API_BASE_URL;

    expect(readConfig).toThrow('EXPO_PUBLIC_API_BASE_URL is required');
  });

  it('fails closed when production Supabase public credentials are absent', () => {
    process.env.APP_ENV = 'production';
    process.env.EXPO_PUBLIC_API_BASE_URL =
      'https://api.release-fixture.danyeodam.app';
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

    expect(readConfig).toThrow('EXPO_PUBLIC_SUPABASE_URL is required');
  });

  it.each(['preview', 'production'])(
    'locks down %s transport and overlay permissions',
    (appEnvironment) => {
      process.env.APP_ENV = appEnvironment;
      process.env.EXPO_PUBLIC_API_BASE_URL =
        'https://api.release-fixture.danyeodam.app';
      setPublicSupabaseTestEnvironment();

      const config = readConfig();

      expect(config.android?.blockedPermissions).toContain(
        'android.permission.SYSTEM_ALERT_WINDOW',
      );
      expect(config.ios?.infoPlist?.NSAppTransportSecurity).toEqual({
        NSAllowsArbitraryLoads: false,
      });
      expect(findPlugin(config, 'expo-build-properties')).toEqual([
        'expo-build-properties',
        expect.objectContaining({
          android: expect.objectContaining({ usesCleartextTraffic: false }),
        }),
      ]);
    },
  );

  it('fails closed when the production policy/support origin allowlist is absent', () => {
    process.env.APP_ENV = 'production';
    process.env.EXPO_PUBLIC_API_BASE_URL =
      'https://api.release-fixture.danyeodam.app';
    setPublicSupabaseTestEnvironment();
    delete process.env.EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS;

    expect(readConfig).toThrow('EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS is required');
  });

  it('rejects a production private endpoint', () => {
    process.env.APP_ENV = 'production';
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://192.168.0.10';

    expect(readConfig).toThrow(
      'must not use private, reserved, documentation, or placeholder hosts',
    );
  });

  it('requires and embeds the verified source commit in a production EAS build', () => {
    process.env.APP_ENV = 'production';
    process.env.EXPO_PUBLIC_API_BASE_URL =
      'https://api.release-fixture.danyeodam.app';
    setPublicSupabaseTestEnvironment();
    process.env.EAS_BUILD = 'true';
    delete process.env.EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA;

    expect(readConfig).toThrow(
      'Production EAS builds require EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA',
    );

    const sourceCommitSha = 'a'.repeat(40);
    process.env.EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA = sourceCommitSha;
    expect(readConfig().extra?.buildSourceCommitSha).toBe(sourceCommitSha);

    process.env.EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA = sourceCommitSha.toUpperCase();
    expect(readConfig).toThrow(
      'Production EAS builds require EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA',
    );
  });

  it('omits an absent source commit from local Expo extra', () => {
    process.env.APP_ENV = 'e2e';
    delete process.env.EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA;

    const config = createExpoConfig({
      config: {
        extra: {
          buildSourceCommitSha: 'stale-config-value',
          expectedServerBonusPackIssuanceScope: 'public',
          mobilePublicConfigSha256: 'stale-config-digest',
          BONUS_PACK_ISSUANCE_SCOPE: 'public',
        },
      },
    } as unknown as ConfigContext);

    expect(config.extra).not.toHaveProperty('buildSourceCommitSha');
    expect(config.extra).not.toHaveProperty(
      'expectedServerBonusPackIssuanceScope',
    );
    expect(config.extra).not.toHaveProperty('mobilePublicConfigSha256');
    expect(config.extra).not.toHaveProperty('BONUS_PACK_ISSUANCE_SCOPE');
  });
});
