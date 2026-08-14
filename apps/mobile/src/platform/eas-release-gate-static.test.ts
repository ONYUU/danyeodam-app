import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createMobilePublicConfigAttestation } from '../../scripts/lib/mobile-public-config-attestation.cjs';

const sourceCommitSha = 'a'.repeat(40);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(testDirectory, '../..');
const gatePath = path.join(mobileRoot, 'scripts/assert-eas-release-gate.mjs');
const mobilePackage = JSON.parse(
  readFileSync(path.join(mobileRoot, 'package.json'), 'utf8'),
) as { version: string };
const productionPublicEnvironment = {
  APP_ENV: 'production',
  EXPO_PUBLIC_API_BASE_URL: 'https://api.release-fixture.danyeodam.app',
  EXPO_PUBLIC_SUPABASE_URL: 'https://release-fixture.supabase.co',
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
    'sb_publishable_F9x7K2mP4qR8sT6vW3yZ5aBcD1eG0hJ',
  EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS:
    'https://support.release-fixture.danyeodam.app,https://policies.release-fixture.danyeodam.app',
};

function mobilePublicConfigSha256(
  expectedServerBonusPackIssuanceScope: 'off' | 'participants' | 'public' = 'off',
) {
  return createMobilePublicConfigAttestation({
    apiBaseUrl: productionPublicEnvironment.EXPO_PUBLIC_API_BASE_URL,
    supabaseUrl: productionPublicEnvironment.EXPO_PUBLIC_SUPABASE_URL,
    supabasePublishableKey:
      productionPublicEnvironment.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    policyAllowedOrigins:
      productionPublicEnvironment.EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS,
    mobileAppVersion: mobilePackage.version,
    sourceCommitSha,
    expectedServerBonusPackIssuanceScope,
  }).mobilePublicConfigSha256;
}

function approvalDocument(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    status: 'approved',
    sourceCommitSha,
    approvedAt: '2020-01-01T00:00:00Z',
    approvedBy: 'release-owner',
    expectedServerBonusPackIssuanceScope: 'off',
    mobilePublicConfigSha256: mobilePublicConfigSha256(),
    evidence: {
      cardAssetRightsSha256: 'b'.repeat(64),
      seoulFieldApprovalSha256: 'c'.repeat(64),
      storePacketPrebuildSha256: 'd'.repeat(64),
    },
    ...overrides,
  };
}

describe('EAS production private release approval gate', () => {
  it('keeps private release evidence outside the public repository', async () => {
    const [packageSource, gateSource] = await Promise.all([
      readFile(new URL('../../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../../scripts/assert-eas-release-gate.mjs', import.meta.url), 'utf8'),
    ]);

    expect(JSON.parse(packageSource).scripts['eas-build-pre-install']).toBe(
      'node ./scripts/assert-eas-release-gate.mjs',
    );
    expect(gateSource).toContain("process.env.EAS_BUILD_PROFILE !== 'production'");
    expect(gateSource).toContain('DANYEODAM_RELEASE_APPROVAL_FILE');
    expect(gateSource).toContain('EAS_BUILD_GIT_COMMIT_HASH');
    expect(gateSource).toContain('mobilePublicConfigSha256');
    expect(gateSource).toContain("'EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA'");
    expect(gateSource).toContain("'set-env'");
    expect(gateSource).not.toMatch(/content\/store-submission|content\/card-assets|content\/seoul-launch/iu);
    expect(gateSource).not.toMatch(/npm|npx|node_modules/iu);
    expect(gateSource).not.toContain('process.env.BONUS_PACK_ISSUANCE_SCOPE');
  });

  it('skips outside production and fails closed without a private approval', () => {
    const inheritedEnvironment = { ...process.env };
    delete inheritedEnvironment.DANYEODAM_RELEASE_APPROVAL_FILE;

    const nonProduction = spawnSync(process.execPath, [gatePath], {
      cwd: mobileRoot,
      encoding: 'utf8',
      env: { ...inheritedEnvironment, EAS_BUILD_PROFILE: 'preview' },
    });
    expect(nonProduction.status).toBe(0);
    expect(`${nonProduction.stdout}${nonProduction.stderr}`).toContain(
      'skipped outside the production profile',
    );

    const production = spawnSync(process.execPath, [gatePath], {
      cwd: mobileRoot,
      encoding: 'utf8',
      env: {
        ...inheritedEnvironment,
        EAS_BUILD: 'true',
        EAS_BUILD_PROFILE: 'production',
        EAS_BUILD_GIT_COMMIT_HASH: sourceCommitSha,
        APP_ENV: 'production',
      },
    });
    expect(production.status).toBe(1);
    expect(`${production.stdout}${production.stderr}`).toContain(
      'DANYEODAM_RELEASE_APPROVAL_FILE must be an absolute path',
    );
  });

  it('accepts only an external, private, commit-bound approval', () => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'danyeodam-release-approval-'));
    const approvalPath = path.join(temporaryDirectory, 'approval.json');
    const fakeBin = path.join(temporaryDirectory, 'bin');
    const setEnvironmentPath = path.join(fakeBin, 'set-env');
    const setEnvironmentLog = path.join(temporaryDirectory, 'set-env.log');
    const inheritedEnvironment = { ...process.env };
    delete inheritedEnvironment.DANYEODAM_RELEASE_APPROVAL_FILE;

    try {
      writeFileSync(
        approvalPath,
        `${JSON.stringify(approvalDocument({
          evidence: {
            cardAssetRightsSha256: '0'.repeat(64),
            seoulFieldApprovalSha256: '0'.repeat(64),
            storePacketPrebuildSha256: '0'.repeat(64),
          },
        }))}\n`,
        { mode: 0o600 },
      );
      chmodSync(approvalPath, 0o600);
      mkdirSync(fakeBin, { mode: 0o700 });
      writeFileSync(
        setEnvironmentPath,
        `#!/bin/sh\nprintf '%s\\n' "$@" > "${setEnvironmentLog}"\n`,
        { mode: 0o700 },
      );
      chmodSync(setEnvironmentPath, 0o700);

      const placeholderApproval = spawnSync(process.execPath, [gatePath], {
        cwd: mobileRoot,
        encoding: 'utf8',
        env: {
          ...inheritedEnvironment,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
          EAS_BUILD: 'true',
          EAS_BUILD_PROFILE: 'production',
          EAS_BUILD_GIT_COMMIT_HASH: sourceCommitSha,
          DANYEODAM_RELEASE_APPROVAL_FILE: approvalPath,
          ...productionPublicEnvironment,
        },
      });
      expect(placeholderApproval.status).toBe(1);
      expect(`${placeholderApproval.stdout}${placeholderApproval.stderr}`).toContain(
        'must not be a placeholder digest',
      );

      writeFileSync(approvalPath, `${JSON.stringify(approvalDocument())}\n`, { mode: 0o600 });
      chmodSync(approvalPath, 0o600);

      const production = spawnSync(process.execPath, [gatePath], {
        cwd: mobileRoot,
        encoding: 'utf8',
        env: {
          ...inheritedEnvironment,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
          EAS_BUILD: 'true',
          EAS_BUILD_PROFILE: 'production',
          EAS_BUILD_GIT_COMMIT_HASH: sourceCommitSha,
          DANYEODAM_RELEASE_APPROVAL_FILE: approvalPath,
          ...productionPublicEnvironment,
        },
      });
      expect(production.status).toBe(0);
      expect(`${production.stdout}${production.stderr}`).toContain(
        'EAS private release approval gate passed',
      );
      expect(readFileSync(setEnvironmentLog, 'utf8')).toBe(
        `EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA\n${sourceCommitSha}\n`,
      );

      const appEnvironmentMutation = spawnSync(process.execPath, [gatePath], {
        cwd: mobileRoot,
        encoding: 'utf8',
        env: {
          ...inheritedEnvironment,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
          EAS_BUILD: 'true',
          EAS_BUILD_PROFILE: 'production',
          EAS_BUILD_GIT_COMMIT_HASH: sourceCommitSha,
          DANYEODAM_RELEASE_APPROVAL_FILE: approvalPath,
          ...productionPublicEnvironment,
          APP_ENV: 'preview',
        },
      });
      expect(appEnvironmentMutation.status).toBe(1);
      expect(
        `${appEnvironmentMutation.stdout}${appEnvironmentMutation.stderr}`,
      ).toContain('must build with APP_ENV=production');

      for (const [label, mutation] of [
        [
          'API URL',
          { EXPO_PUBLIC_API_BASE_URL: 'https://api2.release-fixture.danyeodam.app' },
        ],
        [
          'Supabase URL',
          { EXPO_PUBLIC_SUPABASE_URL: 'https://release-fixture-2.supabase.co' },
        ],
        [
          'publishable key',
          {
            EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
              'sb_publishable_K7m2Q9v4X8c3N6p1R5t0W4y9Z2a7B6d',
          },
        ],
        [
          'policy origins',
          {
            EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS:
              'https://policies.release-fixture.danyeodam.app,https://help.release-fixture.danyeodam.app',
          },
        ],
      ] as const) {
        const mutated = spawnSync(process.execPath, [gatePath], {
          cwd: mobileRoot,
          encoding: 'utf8',
          env: {
            ...inheritedEnvironment,
            PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
            EAS_BUILD: 'true',
            EAS_BUILD_PROFILE: 'production',
            EAS_BUILD_GIT_COMMIT_HASH: sourceCommitSha,
            DANYEODAM_RELEASE_APPROVAL_FILE: approvalPath,
            ...productionPublicEnvironment,
            ...mutation,
          },
        });
        expect(mutated.status, label).toBe(1);
        expect(`${mutated.stdout}${mutated.stderr}`, label).toContain(
          'must match the current production public configuration',
        );
      }

      writeFileSync(
        approvalPath,
        `${JSON.stringify(approvalDocument({
          expectedServerBonusPackIssuanceScope: 'participants',
        }))}\n`,
        { mode: 0o600 },
      );
      chmodSync(approvalPath, 0o600);
      const scopeMutation = spawnSync(process.execPath, [gatePath], {
        cwd: mobileRoot,
        encoding: 'utf8',
        env: {
          ...inheritedEnvironment,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
          EAS_BUILD: 'true',
          EAS_BUILD_PROFILE: 'production',
          EAS_BUILD_GIT_COMMIT_HASH: sourceCommitSha,
          DANYEODAM_RELEASE_APPROVAL_FILE: approvalPath,
          ...productionPublicEnvironment,
        },
      });
      expect(scopeMutation.status).toBe(1);
      expect(`${scopeMutation.stdout}${scopeMutation.stderr}`).toContain(
        'must match the current production public configuration',
      );
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
