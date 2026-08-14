import { describe, expect, it, vi } from 'vitest';

import { ApiTransportError, type ApiClient } from './client';
import {
  createPoliciesService,
  parseCurrentPolicies,
  parseCurrentPolicyManifest,
  selectCurrentConsentPolicies,
} from './policies';

const types = [
  'terms_of_use',
  'privacy_policy',
  'community_guidelines',
  'location_terms',
] as const;
const locales = ['ko', 'en', 'ja', 'zh-Hans', 'zh-Hant', 'vi'] as const;

function payload() {
  return {
    support_url: 'https://support.example/help',
    policies: types.map((type) => ({
      type,
      version: '2026-08-12',
      effective_at: '2026-08-12T00:00:00.000Z',
      documents: Object.fromEntries(locales.map((locale) => [locale, {
        url: `https://policies.example/${type}/${locale}`,
        sha256: 'a'.repeat(64),
      }])),
    })),
  };
}

describe('current policy client', () => {
  it('strictly parses four policy types and six locale documents', async () => {
    expect(parseCurrentPolicies(payload())).toHaveLength(4);
    expect(parseCurrentPolicyManifest(payload()).supportUrl).toBe(
      'https://support.example/help',
    );
    const client = vi.fn(async () => payload()) as unknown as ApiClient;
    await expect(createPoliciesService(client).current()).resolves.toHaveLength(4);
    expect(client).toHaveBeenCalledWith('/api/policies/current', {
      authenticated: false,
    });
  });

  it('accepts the exact current versions and locale selected from the server payload', async () => {
    const client = vi.fn(async (path: string) => (
      path === '/api/policies/current' ? payload() : undefined
    )) as unknown as ApiClient;
    const service = createPoliciesService(client);
    const policies = await service.current();

    await expect(service.accept({ locale: 'ko', policies })).resolves.toBeUndefined();
    expect(client).toHaveBeenLastCalledWith('/api/me/policy-acceptances', {
      method: 'POST',
      json: {
        acceptances: [
          { type: 'terms_of_use', version: '2026-08-12', locale: 'ko' },
          { type: 'community_guidelines', version: '2026-08-12', locale: 'ko' },
        ],
      },
    });
  });

  it('selects the exact locale URLs and hashes shown by the acceptance UI', () => {
    const policies = parseCurrentPolicies(payload());

    expect(selectCurrentConsentPolicies(policies, 'ja').map((policy) => ({
      type: policy.type,
      version: policy.version,
      document: policy.documents.ja,
    }))).toEqual([
      {
        type: 'terms_of_use',
        version: '2026-08-12',
        document: {
          url: 'https://policies.example/terms_of_use/ja',
          sha256: 'a'.repeat(64),
        },
      },
      {
        type: 'community_guidelines',
        version: '2026-08-12',
        document: {
          url: 'https://policies.example/community_guidelines/ja',
          sha256: 'a'.repeat(64),
        },
      },
    ]);
  });

  it('rejects duplicate policy types, insecure URLs, and malformed hashes', () => {
    const duplicate = payload();
    duplicate.policies[3]!.type = 'terms_of_use';
    expect(() => parseCurrentPolicies(duplicate)).toThrow(ApiTransportError);

    const insecure = payload();
    insecure.policies[0]!.documents.ko!.url = 'http://policies.example/terms';
    expect(() => parseCurrentPolicies(insecure)).toThrow(ApiTransportError);

    const malformedHash = payload();
    malformedHash.policies[0]!.documents.ko!.sha256 = 'A'.repeat(64);
    expect(() => parseCurrentPolicies(malformedHash)).toThrow(ApiTransportError);

    const credentialedSupport = payload();
    credentialedSupport.support_url = 'https://user:password@support.example/help';
    expect(() => parseCurrentPolicies(credentialedSupport)).toThrow(ApiTransportError);
  });
});
