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
) as { packageManager?: string; overrides?: Record<string, string> };

describe('EAS toolchain policy', () => {
  it('pins the exact CLI and requires a committed source tree', () => {
    expect(easConfig.cli).toMatchObject({
      version: '21.8.0',
      requireCommit: true,
    });
    expect(packageConfig.packageManager).toBe('npm@11.16.0');
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
    expect(packageConfig.overrides).toMatchObject({
      uuid: '11.1.1',
    });
  });

  it('keeps every non-production profile on internal distribution', () => {
    for (const profileName of ['development', 'e2e', 'preview']) {
      expect(easConfig.build[profileName]?.distribution).toBe('internal');
    }
    expect(easConfig.build.production?.distribution).toBeUndefined();
  });
});
