import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface EasProfile {
  corepack?: boolean;
  distribution?: string;
  node?: string;
}

interface EasConfig {
  cli: {
    requireCommit?: boolean;
    version?: string;
  };
  build: Record<string, EasProfile>;
}

const easConfig = JSON.parse(
  readFileSync(join(process.cwd(), 'eas.json'), 'utf8'),
) as EasConfig;
const packageConfig = JSON.parse(
  readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
) as {
  packageManager?: string;
  overrides?: Record<string, string>;
  scripts?: Record<string, string>;
};
const releaseToolPackage = JSON.parse(
  readFileSync(join(process.cwd(), '..', '..', 'tools', 'eas-cli', 'package.json'), 'utf8'),
) as {
  allowScripts?: Record<string, boolean>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
  packageManager?: string;
  private?: boolean;
};
const releaseToolLock = JSON.parse(
  readFileSync(join(process.cwd(), '..', '..', 'tools', 'eas-cli', 'package-lock.json'), 'utf8'),
) as {
  packages?: Record<string, { integrity?: string; resolved?: string; version?: string }>;
};
const mobileLock = JSON.parse(
  readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8'),
) as {
  packages?: Record<string, { integrity?: string; resolved?: string; version?: string }>;
};

const expectedMetroOverrides = [
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
] as const;

describe('EAS toolchain policy', () => {
  it('runs Expo Doctor through the fail-closed bounded Metro verifier', () => {
    expect(packageConfig.scripts?.doctor).toBe('node ./scripts/run-expo-doctor.mjs');
  });

  it('pins the exact CLI and requires a committed source tree', () => {
    expect(easConfig.cli).toMatchObject({
      version: '22.2.0',
      requireCommit: true,
    });
    expect(packageConfig.packageManager).toBe('npm@11.16.0');
  });

  it('runs the lockfile-bound EAS CLI without a registry-time install', () => {
    const typedPackage = packageConfig as typeof packageConfig & {
      allowScripts?: Record<string, boolean>;
      scripts?: Record<string, string>;
    };
    expect(releaseToolPackage).toMatchObject({
      private: true,
      packageManager: 'npm@11.16.0',
      engines: { node: '>=24.19.0 <25' },
      devDependencies: { 'eas-cli': '22.2.0' },
    });
    expect(typedPackage.scripts?.['release:build']).toBe(
      'corepack npm run release:preflight && corepack npm --offline --prefix ../../tools/eas-cli run eas -- build --profile production --platform all',
    );
    expect((releaseToolPackage as typeof releaseToolPackage & { scripts?: Record<string, string> }).scripts).toEqual({
      eas: 'eas',
    });
    expect(typedPackage.allowScripts).toEqual({
      'fsevents@2.3.3': true,
      'unrs-resolver@1.12.2': true,
    });
    expect(releaseToolPackage.allowScripts).toEqual({
      'dtrace-provider': false,
    });
    expect(releaseToolLock.packages?.['node_modules/eas-cli']).toMatchObject({
      version: '22.2.0',
      resolved: 'https://registry.npmjs.org/eas-cli/-/eas-cli-22.2.0.tgz',
    });
    expect(releaseToolLock.packages?.['node_modules/eas-cli']?.integrity).toMatch(/^sha512-/u);
  });

  it('pins Node and enables Corepack in every build profile', () => {
    expect(Object.keys(easConfig.build).sort()).toEqual([
      'development',
      'e2e',
      'preview',
      'production',
    ]);

    for (const profile of Object.values(easConfig.build)) {
      expect(profile.node).toBe('24.19.0');
      expect(profile.corepack).toBe(true);
    }
  });

  it('overrides the vulnerable transitive UUID used by the native Xcode tool', () => {
    expect(packageConfig.overrides).toEqual({
      ...Object.fromEntries(expectedMetroOverrides.map((packageName) => [packageName, '0.84.5'])),
      uuid: '11.1.1',
    });
  });

  it('keeps the complete Metro stable family on the bounded image parser release', () => {
    for (const packageName of expectedMetroOverrides) {
      expect(mobileLock.packages?.[`node_modules/${packageName}`]).toMatchObject({
        version: '0.84.5',
        resolved: `https://registry.npmjs.org/${packageName}/-/${packageName}-0.84.5.tgz`,
      });
      expect(mobileLock.packages?.[`node_modules/${packageName}`]?.integrity).toMatch(/^sha512-/u);
    }
    const packageEntries = Object.entries(mobileLock.packages ?? {});
    expect(packageEntries.filter(([entryPath]) => (
      entryPath === 'node_modules/image-size' || entryPath.endsWith('/node_modules/image-size')
    ))).toEqual([]);
    expect(packageEntries.filter(([entryPath, lockedPackage]) => (
      expectedMetroOverrides.some((packageName) => (
        entryPath === `node_modules/${packageName}`
          || entryPath.endsWith(`/node_modules/${packageName}`)
      )) && lockedPackage.version !== '0.84.5'
    ))).toEqual([]);
  });

  it('keeps every non-production profile on internal distribution', () => {
    for (const profileName of ['development', 'e2e', 'preview']) {
      expect(easConfig.build[profileName]?.distribution).toBe('internal');
    }
    expect(easConfig.build.production?.distribution).toBeUndefined();
  });
});
