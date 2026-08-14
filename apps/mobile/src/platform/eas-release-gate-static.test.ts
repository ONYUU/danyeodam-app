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

const sourceCommitSha = 'a'.repeat(40);

function approvalDocument(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    status: 'approved',
    sourceCommitSha,
    approvedAt: '2020-01-01T00:00:00Z',
    approvedBy: 'release-owner',
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
    expect(gateSource).toContain("'EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA'");
    expect(gateSource).toContain("'set-env'");
    expect(gateSource).not.toMatch(/content\/store-submission|content\/card-assets|content\/seoul-launch/iu);
    expect(gateSource).not.toMatch(/npm|npx|node_modules/iu);
  });

  it('skips outside production and fails closed without a private approval', () => {
    const testDirectory = path.dirname(fileURLToPath(import.meta.url));
    const mobileRoot = path.resolve(testDirectory, '../..');
    const gatePath = path.join(mobileRoot, 'scripts/assert-eas-release-gate.mjs');
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
        EAS_BUILD_PROFILE: 'production',
        EAS_BUILD_GIT_COMMIT_HASH: sourceCommitSha,
      },
    });
    expect(production.status).toBe(1);
    expect(`${production.stdout}${production.stderr}`).toContain(
      'DANYEODAM_RELEASE_APPROVAL_FILE must be an absolute path',
    );
  });

  it('accepts only an external, private, commit-bound approval', () => {
    const testDirectory = path.dirname(fileURLToPath(import.meta.url));
    const mobileRoot = path.resolve(testDirectory, '../..');
    const gatePath = path.join(mobileRoot, 'scripts/assert-eas-release-gate.mjs');
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
        },
      });
      expect(production.status).toBe(0);
      expect(`${production.stdout}${production.stderr}`).toContain(
        'EAS private release approval gate passed',
      );
      expect(readFileSync(setEnvironmentLog, 'utf8')).toBe(
        `EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA\n${sourceCommitSha}\n`,
      );
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
