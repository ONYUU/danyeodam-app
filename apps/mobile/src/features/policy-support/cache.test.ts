import { describe, expect, it } from 'vitest';

import type { CurrentPolicyManifest } from '@/api/policies';

import { encodeCachedPolicyManifest, parseCachedPolicyManifest } from './cache';

const locales = ['ko', 'en', 'ja', 'zh-Hans', 'zh-Hant', 'vi'] as const;

function manifest(): CurrentPolicyManifest {
  return {
    supportUrl: 'https://support.example/help',
    policies: ['terms_of_use', 'privacy_policy', 'community_guidelines', 'location_terms']
      .map((type) => ({
        type: type as CurrentPolicyManifest['policies'][number]['type'],
        version: '2026-08-13',
        effectiveAt: '2026-08-13T00:00:00.000Z',
        documents: Object.fromEntries(locales.map((locale) => [locale, {
          url: `https://policies.example/${type}/${locale}`,
          sha256: 'a'.repeat(64),
        }])) as CurrentPolicyManifest['policies'][number]['documents'],
      })),
  };
}

describe('offline policy manifest cache', () => {
  it('round-trips the strict server projection and saved timestamp', () => {
    const savedAt = '2026-08-13T01:02:03.000Z';
    expect(parseCachedPolicyManifest(
      encodeCachedPolicyManifest(manifest(), savedAt),
    )).toEqual({ manifest: manifest(), savedAt });
  });

  it('fails closed for corrupted or structurally incomplete cache data', () => {
    expect(() => parseCachedPolicyManifest('{not-json')).toThrow();
    expect(() => parseCachedPolicyManifest(JSON.stringify({
      version: 1,
      saved_at: 'not-a-date',
      policies: [],
    }))).toThrow();
  });
});
