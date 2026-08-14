import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createMobilePublicConfigAttestation,
  type MobilePublicConfigAttestationInput,
} from '../../scripts/lib/mobile-public-config-attestation.cjs';

const sourceCommitSha = '0123456789abcdef0123456789abcdef01234567';
const publicKey = 'sb_publishable_F9x7K2mP4qR8sT6vW3yZ5aBcD1eG0hJ';
const baseInput: MobilePublicConfigAttestationInput = {
  apiBaseUrl: 'https://api.release-fixture.danyeodam.app',
  supabaseUrl: 'https://release-fixture.supabase.co',
  supabasePublishableKey: publicKey,
  policyAllowedOrigins:
    'https://support.release-fixture.danyeodam.app,https://policies.release-fixture.danyeodam.app',
  mobileAppVersion: '0.1.0',
  sourceCommitSha,
  expectedServerBonusPackIssuanceScope: 'off',
};

describe('mobile public configuration attestation', () => {
  it('canonicalizes sorted origins and fingerprints rather than copying the public key', () => {
    const attestation = createMobilePublicConfigAttestation(baseInput);

    expect(attestation.mobilePublicConfigSha256).toBe(
      '1f91f0356d7904ba7425ad862e6c93f759fd1df31422efa9f167e65b7666d448',
    );
    expect(attestation.canonicalConfig.policyAllowedOrigins).toEqual([
      'https://policies.release-fixture.danyeodam.app',
      'https://support.release-fixture.danyeodam.app',
    ]);
    expect(attestation.canonicalConfig.supabasePublishableKeyFingerprintSha256)
      .toMatch(/^[a-f0-9]{64}$/u);
    expect(attestation.canonicalJson).not.toContain(publicKey);

    const reversed = createMobilePublicConfigAttestation({
      ...baseInput,
      policyAllowedOrigins:
        'https://policies.release-fixture.danyeodam.app,https://support.release-fixture.danyeodam.app',
    });
    expect(reversed.mobilePublicConfigSha256).toBe(
      attestation.mobilePublicConfigSha256,
    );
  });

  it.each([
    ['production API URL', { apiBaseUrl: 'https://api2.release-fixture.danyeodam.app' }],
    ['Supabase URL', { supabaseUrl: 'https://release-fixture-2.supabase.co' }],
    [
      'publishable key fingerprint',
      { supabasePublishableKey: 'sb_publishable_K7m2Q9v4X8c3N6p1R5t0W4y9Z2a7B6d' },
    ],
    [
      'policy origins',
      {
        policyAllowedOrigins:
          'https://policies.release-fixture.danyeodam.app,https://help.release-fixture.danyeodam.app',
      },
    ],
    ['mobile app version', { mobileAppVersion: '0.1.1' }],
    ['source commit', { sourceCommitSha: '89abcdef0123456789abcdef0123456789abcdef' }],
    [
      'expected server rollout scope',
      { expectedServerBonusPackIssuanceScope: 'participants' },
    ],
  ] as const)('changes the digest when %s changes', (_label, mutation) => {
    const baseline = createMobilePublicConfigAttestation(baseInput);
    const changed = createMobilePublicConfigAttestation({
      ...baseInput,
      ...mutation,
    });
    expect(changed.mobilePublicConfigSha256).not.toBe(
      baseline.mobilePublicConfigSha256,
    );
  });

  it('rejects reserved production config and an unknown server scope', () => {
    expect(() => createMobilePublicConfigAttestation({
      ...baseInput,
      apiBaseUrl: 'https://api.invalid',
    })).toThrow('placeholder hosts');
    expect(() => createMobilePublicConfigAttestation({
      ...baseInput,
      expectedServerBonusPackIssuanceScope: 'enabled' as never,
    })).toThrow('must be off, participants, or public');
  });

  it('prints only the canonical digest from the operator command', () => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), 'scripts/compute-mobile-public-config-sha256.mjs'),
        sourceCommitSha,
        'off',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          EXPO_PUBLIC_API_BASE_URL: baseInput.apiBaseUrl,
          EXPO_PUBLIC_SUPABASE_URL: baseInput.supabaseUrl,
          EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
            baseInput.supabasePublishableKey,
          EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS:
            baseInput.policyAllowedOrigins,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      '1f91f0356d7904ba7425ad862e6c93f759fd1df31422efa9f167e65b7666d448\n',
    );
  });
});
