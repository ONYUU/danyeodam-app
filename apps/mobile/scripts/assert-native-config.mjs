import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const expoCliPath = require.resolve('expo/bin/cli');
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const mobilePackage = JSON.parse(
  readFileSync(join(projectRoot, 'package.json'), 'utf8'),
);
const supportedLocales = ['ko', 'en', 'ja', 'zh-Hans', 'zh-Hant', 'vi'];
const productionEnvironment = {
  ...process.env,
  APP_ENV: 'production',
  CI: '1',
  EXPO_NO_TELEMETRY: '1',
  EXPO_PUBLIC_API_BASE_URL: 'https://api.release-fixture.danyeodam.app',
  EXPO_PUBLIC_SUPABASE_URL: 'https://release-fixture.supabase.co',
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
    'sb_publishable_F9x7K2mP4qR8sT6vW3yZ5aBcD1eG0hJ',
  EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS:
    'https://policies.release-fixture.danyeodam.app,https://support.release-fixture.danyeodam.app',
};

function runExpo(args, cwd = projectRoot) {
  const result = spawnSync(process.execPath, [expoCliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: productionEnvironment,
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(
      [`expo ${args.join(' ')} failed.`, result.stdout, result.stderr]
        .filter(Boolean)
        .join('\n'),
    );
  }

  return result.stdout;
}

function findFiles(root, fileName) {
  if (!existsSync(root)) {
    return [];
  }

  const matches = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      matches.push(...findFiles(entryPath, fileName));
    } else if (entry.name === fileName) {
      matches.push(entryPath);
    }
  }
  return matches;
}

function findMatchingFiles(root, pattern) {
  if (!existsSync(root)) {
    return [];
  }

  const matches = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      matches.push(...findMatchingFiles(entryPath, pattern));
    } else if (pattern.test(entry.name)) {
      matches.push(entryPath);
    }
  }
  return matches;
}

function permissionState(permissionEntries, permissionName) {
  const matching = permissionEntries.filter(
    (entry) => entry.$?.['android:name'] === permissionName,
  );
  return {
    declared: matching.some((entry) => entry.$?.['tools:node'] !== 'remove'),
    removed: matching.some((entry) => entry.$?.['tools:node'] === 'remove'),
  };
}

function assertIntrospection() {
  const rawConfig = JSON.parse(
    runExpo(['config', '--type', 'introspect', '--json']),
  );
  const config = rawConfig.exp ?? rawConfig;
  const modResults = config._internal?.modResults;
  const infoPlist = modResults?.ios?.infoPlist;
  const manifest = modResults?.android?.manifest?.manifest;

  assert(infoPlist, 'Expo introspection did not return the iOS Info.plist.');
  assert(manifest, 'Expo introspection did not return the Android manifest.');
  assert.equal(config.ios?.bundleIdentifier, 'kr.danyeodam.app');
  assert.equal(config.android?.package, 'kr.danyeodam.app');
  assert.equal(config.version, mobilePackage.version);
  assert.equal(
    config.extra?.supabaseUrl,
    'https://release-fixture.supabase.co',
  );
  assert.deepEqual(config.extra?.policyAllowedOrigins, [
    'https://policies.release-fixture.danyeodam.app',
    'https://support.release-fixture.danyeodam.app',
  ]);
  assert.deepEqual(Object.keys(config.locales ?? {}).sort(), [...supportedLocales].sort());

  assert.equal(infoPlist.CFBundleAllowMixedLocalizations, true);
  assert.deepEqual(
    [...(infoPlist.CFBundleLocalizations ?? [])].sort(),
    [...supportedLocales].sort(),
  );
  assert.equal(
    infoPlist.NSLocationWhenInUseUsageDescription,
    '다녀담은 사용자가 카드 획득을 시도할 때만 현재 위치를 확인합니다.',
  );

  for (const forbiddenKey of [
    'NSLocationAlwaysAndWhenInUseUsageDescription',
    'NSLocationAlwaysUsageDescription',
    'NSMotionUsageDescription',
    'NSPhotoLibraryUsageDescription',
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription',
    'NSFaceIDUsageDescription',
  ]) {
    assert.equal(
      infoPlist[forbiddenKey],
      undefined,
      `${forbiddenKey} must be absent from the production Info.plist.`,
    );
  }
  assert.equal(infoPlist.UIBackgroundModes, undefined);
  assert.equal(
    infoPlist.NSAppTransportSecurity?.NSAllowsArbitraryLoads,
    false,
  );
  assert.equal(
    infoPlist.NSAppTransportSecurity?.NSAllowsLocalNetworking,
    undefined,
  );
  assert.equal(
    infoPlist.NSAppTransportSecurity?.NSExceptionDomains,
    undefined,
  );

  const permissionEntries = manifest['uses-permission'] ?? [];
  for (const permissionName of [
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.ACCESS_FINE_LOCATION',
  ]) {
    const state = permissionState(permissionEntries, permissionName);
    assert.equal(state.declared, true, `${permissionName} must be declared.`);
    assert.equal(state.removed, false, `${permissionName} must not be removed.`);
  }

  for (const permissionName of [
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
    'android.permission.SYSTEM_ALERT_WINDOW',
  ]) {
    const state = permissionState(permissionEntries, permissionName);
    assert.equal(
      state.declared && !state.removed,
      false,
      `${permissionName} must not survive manifest merging.`,
    );
  }

  const applicationAttributes = manifest.application?.[0]?.$;
  assert.equal(applicationAttributes?.['android:usesCleartextTraffic'], 'false');
}

function assertGeneratedLocaleResources() {
  const temporaryProject = mkdtempSync(join(tmpdir(), 'danyeodam-native-'));

  try {
    for (const fileName of ['app.config.ts', 'package.json']) {
      cpSync(join(projectRoot, fileName), join(temporaryProject, fileName));
    }
    for (const directoryName of ['assets', 'locales']) {
      cpSync(join(projectRoot, directoryName), join(temporaryProject, directoryName), {
        recursive: true,
      });
    }

    const temporaryConfigDirectory = join(
      temporaryProject,
      'src',
      'config',
    );
    mkdirSync(temporaryConfigDirectory, { recursive: true });
    cpSync(
      join(projectRoot, 'src', 'config', 'public-environment.cjs'),
      join(temporaryConfigDirectory, 'public-environment.cjs'),
    );
    symlinkSync(join(projectRoot, 'node_modules'), join(temporaryProject, 'node_modules'), 'junction');

    runExpo(
      ['prebuild', '--clean', '--no-install', '--platform', 'all'],
      temporaryProject,
    );

    const stringsFiles = findFiles(join(temporaryProject, 'ios'), 'InfoPlist.strings');
    assert.equal(
      stringsFiles.length,
      supportedLocales.length,
      `Expected ${supportedLocales.length} localized InfoPlist.strings files, found ${stringsFiles.length}.`,
    );

    for (const locale of supportedLocales) {
      const localeFile = stringsFiles.find((filePath) =>
        filePath.includes(`${locale}.lproj`),
      );
      assert(localeFile, `Missing ${locale}.lproj/InfoPlist.strings.`);

      const expectedLocale = JSON.parse(
        readFileSync(join(projectRoot, 'locales', `${locale}.json`), 'utf8'),
      );
      const stringsContents = readFileSync(localeFile, 'utf8');
      assert(
        stringsContents.includes(
          `NSLocationWhenInUseUsageDescription = "${expectedLocale.ios.NSLocationWhenInUseUsageDescription}";`,
        ),
        `${relative(temporaryProject, localeFile)} has an unexpected location disclosure.`,
      );
      assert.equal(stringsContents.includes('NSPhotoLibraryUsageDescription'), false);
    }

    const androidManifestPath = join(
      temporaryProject,
      'android',
      'app',
      'src',
      'main',
      'AndroidManifest.xml',
    );
    const androidManifest = readFileSync(androidManifestPath, 'utf8');
    assert(
      androidManifest.includes('android:usesCleartextTraffic="false"'),
      `${basename(androidManifestPath)} must disable cleartext traffic.`,
    );

    const splashResources = findMatchingFiles(
      join(temporaryProject, 'android', 'app', 'src', 'main', 'res'),
      /^splashscreen_logo\.(?:png|webp|xml)$/,
    );
    assert(
      splashResources.length > 0,
      'Expo prebuild must generate the splashscreen_logo Android resource referenced by AppTheme.',
    );
  } finally {
    rmSync(temporaryProject, { recursive: true, force: true });
  }
}

assertIntrospection();
assertGeneratedLocaleResources();
console.log(
  'Production native config passed permissions, transport security, and six-locale assertions.',
);
