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
const plist = require('@expo/plist').default;
const expoCliPath = require.resolve('expo/bin/cli');
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const mobilePackage = JSON.parse(
  readFileSync(join(projectRoot, 'package.json'), 'utf8'),
);
const supportedLocales = ['ko', 'en', 'ja', 'zh-Hans', 'zh-Hant', 'vi'];
const buildSourceCommitSha = 'c'.repeat(40);
const iosBuildSourceMarkerKey = 'DanyeodamBuildSourceCommitSha';
const androidBuildSourceMarkerName =
  'kr.danyeodam.app.BUILD_SOURCE_COMMIT_SHA';
const expectedPrivacyAccessedApiTypes = [
  {
    NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace',
    NSPrivacyAccessedAPITypeReasons: ['85F4.1', 'E174.1'],
  },
  {
    NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp',
    NSPrivacyAccessedAPITypeReasons: ['0A2A.1', '3B52.1', 'C617.1'],
  },
  {
    NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime',
    NSPrivacyAccessedAPITypeReasons: ['35F9.1'],
  },
  {
    NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
    NSPrivacyAccessedAPITypeReasons: ['CA92.1'],
  },
];
const expectedPrivacyCollectedDataTypes = [
  ...[
    'NSPrivacyCollectedDataTypeEmailAddress',
    'NSPrivacyCollectedDataTypeGameplayContent',
    'NSPrivacyCollectedDataTypeOtherUserContent',
    'NSPrivacyCollectedDataTypePhotosorVideos',
  ].map((dataType) => ({
    NSPrivacyCollectedDataType: dataType,
    NSPrivacyCollectedDataTypeLinked: true,
    NSPrivacyCollectedDataTypeTracking: false,
    NSPrivacyCollectedDataTypePurposes: [
      'NSPrivacyCollectedDataTypePurposeAppFunctionality',
    ],
  })),
  ...[
    'NSPrivacyCollectedDataTypePreciseLocation',
    'NSPrivacyCollectedDataTypeUserID',
  ].map((dataType) => ({
    NSPrivacyCollectedDataType: dataType,
    NSPrivacyCollectedDataTypeLinked: true,
    NSPrivacyCollectedDataTypeTracking: false,
    NSPrivacyCollectedDataTypePurposes: [
      'NSPrivacyCollectedDataTypePurposeAnalytics',
      'NSPrivacyCollectedDataTypePurposeAppFunctionality',
    ],
  })),
  {
    NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeDeviceID',
    NSPrivacyCollectedDataTypeLinked: false,
    NSPrivacyCollectedDataTypeTracking: false,
    NSPrivacyCollectedDataTypePurposes: [
      'NSPrivacyCollectedDataTypePurposeAppFunctionality',
    ],
  },
  {
    NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeProductInteraction',
    NSPrivacyCollectedDataTypeLinked: true,
    NSPrivacyCollectedDataTypeTracking: false,
    NSPrivacyCollectedDataTypePurposes: [
      'NSPrivacyCollectedDataTypePurposeAnalytics',
    ],
  },
].sort((left, right) =>
  left.NSPrivacyCollectedDataType.localeCompare(
    right.NSPrivacyCollectedDataType,
  ),
);
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
  EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA: buildSourceCommitSha,
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

function normalizePrivacyAccessedApiTypes(entries) {
  return entries
    .map((entry) => ({
      ...entry,
      NSPrivacyAccessedAPITypeReasons: [
        ...entry.NSPrivacyAccessedAPITypeReasons,
      ].sort(),
    }))
    .sort((left, right) =>
      left.NSPrivacyAccessedAPIType.localeCompare(
        right.NSPrivacyAccessedAPIType,
      ),
    );
}

function normalizePrivacyCollectedDataTypes(entries) {
  return entries
    .map((entry) => ({
      ...entry,
      NSPrivacyCollectedDataTypePurposes: [
        ...entry.NSPrivacyCollectedDataTypePurposes,
      ].sort(),
    }))
    .sort((left, right) =>
      left.NSPrivacyCollectedDataType.localeCompare(
        right.NSPrivacyCollectedDataType,
      ),
    );
}

function assertPrivacyManifest(privacyManifest, source) {
  assert.equal(
    privacyManifest.NSPrivacyTracking,
    false,
    `${source} must declare tracking disabled.`,
  );
  assert.deepEqual(
    privacyManifest.NSPrivacyTrackingDomains ?? [],
    [],
    `${source} must not declare tracking domains.`,
  );
  assert.deepEqual(
    normalizePrivacyAccessedApiTypes(
      privacyManifest.NSPrivacyAccessedAPITypes ?? [],
    ),
    expectedPrivacyAccessedApiTypes,
    `${source} has incomplete or unexpected required-reason API declarations.`,
  );
  assert.deepEqual(
    normalizePrivacyCollectedDataTypes(
      privacyManifest.NSPrivacyCollectedDataTypes ?? [],
    ),
    expectedPrivacyCollectedDataTypes,
    `${source} has incomplete or unexpected collected-data declarations.`,
  );
}

function assertDependencyPrivacyManifestCoverage() {
  const manifestPaths = findFiles(
    join(projectRoot, 'node_modules'),
    'PrivacyInfo.xcprivacy',
  );
  assert(
    manifestPaths.length > 0,
    'Installed native dependencies must include privacy manifests for union verification.',
  );
  const reasonsByCategory = new Map();
  const collectedDataDeclarations = [];
  for (const manifestPath of manifestPaths) {
    const manifest = plist.parse(readFileSync(manifestPath, 'utf8'));
    for (const entry of manifest.NSPrivacyAccessedAPITypes ?? []) {
      const reasons = reasonsByCategory.get(entry.NSPrivacyAccessedAPIType)
        ?? new Set();
      for (const reason of entry.NSPrivacyAccessedAPITypeReasons ?? []) {
        reasons.add(reason);
      }
      reasonsByCategory.set(entry.NSPrivacyAccessedAPIType, reasons);
    }
    for (const entry of manifest.NSPrivacyCollectedDataTypes ?? []) {
      collectedDataDeclarations.push({
        manifest: relative(projectRoot, manifestPath),
        entry,
      });
    }
  }
  const dependencyReasonUnion = [...reasonsByCategory.entries()].map(
    ([NSPrivacyAccessedAPIType, reasons]) => ({
      NSPrivacyAccessedAPIType,
      NSPrivacyAccessedAPITypeReasons: [...reasons].sort(),
    }),
  );
  assert.deepEqual(
    normalizePrivacyAccessedApiTypes(dependencyReasonUnion),
    expectedPrivacyAccessedApiTypes,
    'The app required-reason API declaration must equal the installed dependency manifest union.',
  );
  assert.deepEqual(
    collectedDataDeclarations,
    [],
    'A dependency declared collected data; review it and update the app manifest and store disclosures explicitly.',
  );
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
  assertPrivacyManifest(config.ios?.privacyManifests ?? {}, 'Expo config');
  assert.equal(config.extra?.buildSourceCommitSha, buildSourceCommitSha);

  assert.equal(infoPlist.CFBundleAllowMixedLocalizations, true);
  assert.equal(infoPlist[iosBuildSourceMarkerKey], buildSourceCommitSha);
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
  const buildSourceMarkers = (manifest.application?.[0]?.['meta-data'] ?? [])
    .filter(
      (entry) =>
        entry.$?.['android:name'] === androidBuildSourceMarkerName,
    );
  assert.equal(buildSourceMarkers.length, 1);
  assert.equal(
    buildSourceMarkers[0]?.$?.['android:value'],
    buildSourceCommitSha,
  );
}

function assertGeneratedLocaleResources() {
  const temporaryProject = mkdtempSync(join(tmpdir(), 'danyeodam-native-'));

  try {
    for (const fileName of ['app.config.ts', 'package.json']) {
      cpSync(join(projectRoot, fileName), join(temporaryProject, fileName));
    }
    for (const directoryName of ['assets', 'locales', 'plugins']) {
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

    const privacyManifestFiles = findFiles(
      join(temporaryProject, 'ios'),
      'PrivacyInfo.xcprivacy',
    );
    assert.equal(
      privacyManifestFiles.length,
      1,
      `Expected one app PrivacyInfo.xcprivacy, found ${privacyManifestFiles.length}.`,
    );
    const privacyManifestPath = privacyManifestFiles[0];
    assert(privacyManifestPath, 'Expo prebuild did not generate PrivacyInfo.xcprivacy.');
    const privacyManifest = plist.parse(
      readFileSync(privacyManifestPath, 'utf8'),
    );
    assertPrivacyManifest(
      privacyManifest,
      relative(temporaryProject, privacyManifestPath),
    );

    const xcodeProjectFiles = findMatchingFiles(
      join(temporaryProject, 'ios'),
      /^project\.pbxproj$/,
    );
    assert.equal(
      xcodeProjectFiles.length,
      1,
      `Expected one Xcode project file, found ${xcodeProjectFiles.length}.`,
    );
    const xcodeProjectPath = xcodeProjectFiles[0];
    assert(xcodeProjectPath, 'Expo prebuild did not generate an Xcode project.');
    const xcodeProject = readFileSync(xcodeProjectPath, 'utf8');
    assert(
      /\/\* Begin PBXResourcesBuildPhase section \*\/[\s\S]*PrivacyInfo\.xcprivacy in Resources[\s\S]*\/\* End PBXResourcesBuildPhase section \*\//u.test(
        xcodeProject,
      ),
      'The Xcode app target must include PrivacyInfo.xcprivacy as a resource.',
    );

    const generatedInfoPlistFiles = findFiles(
      join(temporaryProject, 'ios'),
      'Info.plist',
    ).filter((filePath) => !filePath.includes('/Pods/'));
    assert.equal(
      generatedInfoPlistFiles.length,
      1,
      `Expected one generated app Info.plist, found ${generatedInfoPlistFiles.length}.`,
    );
    const generatedInfoPlistPath = generatedInfoPlistFiles[0];
    assert(generatedInfoPlistPath, 'Expo prebuild did not generate the app Info.plist.');
    const generatedInfoPlist = plist.parse(
      readFileSync(generatedInfoPlistPath, 'utf8'),
    );
    assert.equal(
      generatedInfoPlist[iosBuildSourceMarkerKey],
      buildSourceCommitSha,
      'The generated app Info.plist must contain the exact build source marker.',
    );

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
    const markerNameMatches = androidManifest.match(
      new RegExp(`android:name="${androidBuildSourceMarkerName.replaceAll('.', '\\.') }"`, 'gu'),
    ) ?? [];
    assert.equal(
      markerNameMatches.length,
      1,
      `${basename(androidManifestPath)} must contain exactly one build source marker.`,
    );
    assert(
      androidManifest.includes(
        `android:name="${androidBuildSourceMarkerName}" android:value="${buildSourceCommitSha}"`,
      ),
      `${basename(androidManifestPath)} must contain the exact build source SHA.`,
    );

    const androidGradleProperties = readFileSync(
      join(temporaryProject, 'android', 'gradle.properties'),
      'utf8',
    );
    assert.match(
      androidGradleProperties,
      /^android\.compileSdkVersion=36$/mu,
      'Expo prebuild must compile with Android API 36.',
    );
    assert.match(
      androidGradleProperties,
      /^android\.targetSdkVersion=36$/mu,
      'Expo prebuild must target Android API 36 for the 2026 Google Play gate.',
    );

    const iosPodfile = readFileSync(
      join(temporaryProject, 'ios', 'Podfile'),
      'utf8',
    );
    assert(
      iosPodfile.includes("platform :ios, podfile_properties['ios.deploymentTarget'] || '16.4'"),
      'Expo prebuild must retain the SDK 57 iOS 16.4 deployment baseline.',
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

assertDependencyPrivacyManifestCoverage();
assertIntrospection();
assertGeneratedLocaleResources();
console.log(
  'Production native config passed privacy, permissions, store SDK, transport security, and six-locale assertions.',
);
