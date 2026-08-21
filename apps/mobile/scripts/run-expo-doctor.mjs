import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metroPackages = [
  'metro',
  'metro-babel-transformer',
  'metro-cache',
  'metro-cache-key',
  'metro-config',
  'metro-core',
  'metro-file-map',
  'metro-minify-terser',
  'metro-resolver',
  'metro-runtime',
  'metro-source-map',
  'metro-symbolicate',
  'metro-transform-plugins',
  'metro-transform-worker',
];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function isPackageLockPath(entryPath, packageName) {
  return entryPath === `node_modules/${packageName}`
    || entryPath.endsWith(`/node_modules/${packageName}`);
}

export function assertBoundedMetroInstallation() {
  const packageConfig = readJson(path.join(projectRoot, 'package.json'));
  const lock = readJson(path.join(projectRoot, 'package-lock.json'));

  for (const packageName of metroPackages) {
    if (packageConfig.overrides?.[packageName] !== '0.84.5') {
      throw new Error(`Expected package.json to pin ${packageName} to 0.84.5.`);
    }

    const lockedPackage = lock.packages?.[`node_modules/${packageName}`];
    if (lockedPackage?.version !== '0.84.5') {
      throw new Error(`Expected package-lock.json to resolve ${packageName} to 0.84.5.`);
    }

    const installedPackage = readJson(
      path.join(projectRoot, 'node_modules', packageName, 'package.json'),
    );
    if (installedPackage.version !== '0.84.5') {
      throw new Error(`Expected the installed ${packageName} version to be 0.84.5.`);
    }
  }

  for (const [entryPath, lockedPackage] of Object.entries(lock.packages ?? {})) {
    if (isPackageLockPath(entryPath, 'image-size')) {
      throw new Error(`The bounded Metro family must not install image-size: ${entryPath}`);
    }

    for (const packageName of metroPackages) {
      if (isPackageLockPath(entryPath, packageName) && lockedPackage.version !== '0.84.5') {
        throw new Error(`Every locked ${packageName} instance must resolve to 0.84.5: ${entryPath}`);
      }
    }
  }
}

function stripAnsi(value) {
  return value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '');
}

export function isOnlyExpectedOverrideFailure(output) {
  const normalized = stripAnsi(output);
  const lines = normalized.split(/\r?\n/u).map((line) => line.trim());
  const failureMarkers = lines.filter((line) => line.startsWith('✖ '));
  const mismatchLines = lines.filter((line) => line.includes(' should install '));
  const expectedMismatchLines = metroPackages.map(
    (packageName) => (
      `"@expo/metro" should install "${packageName}@0.84.4", but 0.84.5 is installed.`
    ),
  );

  return normalized.includes('20/21 checks passed. 1 checks failed.')
    && failureMarkers.length === 1
    && failureMarkers[0] === '✖ Check for overridden dependencies'
    && mismatchLines.length === expectedMismatchLines.length
    && expectedMismatchLines.every((line) => mismatchLines.includes(line));
}

function run() {
  try {
    assertBoundedMetroInstallation();

    const doctor = spawnSync(
      process.execPath,
      [path.join(projectRoot, 'node_modules/expo-doctor/bin/expo-doctor.js'), '.'],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        env: process.env,
        maxBuffer: 8 * 1024 * 1024,
      },
    );

    process.stdout.write(doctor.stdout ?? '');
    process.stderr.write(doctor.stderr ?? '');

    if (doctor.error || doctor.signal || ![0, 1].includes(doctor.status)) {
      throw doctor.error
        ?? new Error(`Expo Doctor terminated unexpectedly: ${doctor.signal ?? doctor.status}`);
    }

    if (doctor.status === 0) {
      process.exit(0);
    }

    if (!isOnlyExpectedOverrideFailure(`${doctor.stdout ?? ''}\n${doctor.stderr ?? ''}`)) {
      throw new Error(
        'Expo Doctor reported a failure outside the exact bounded Metro 0.84.5 override.',
      );
    }

    console.log(
      'Expo Doctor exception verified: only the complete Metro 0.84.5 bounded-parser family differs from Expo 57.0.15.',
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run();
}
