import type { CurrentPolicyManifest } from '@/api/policies';
import { parseCurrentPolicyManifest } from '@/api/policies';

export type CachedPolicyManifest = {
  manifest: CurrentPolicyManifest;
  savedAt: string;
};

export function encodeCachedPolicyManifest(
  manifest: CurrentPolicyManifest,
  savedAt = new Date().toISOString(),
): string {
  return JSON.stringify({
    version: 1,
    saved_at: savedAt,
    support_url: manifest.supportUrl,
    policies: manifest.policies.map((policy) => ({
      type: policy.type,
      version: policy.version,
      effective_at: policy.effectiveAt,
      documents: policy.documents,
    })),
  });
}

export function parseCachedPolicyManifest(raw: string): CachedPolicyManifest {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (value.version !== 1 || typeof value.saved_at !== 'string') {
    throw new Error('POLICY_CACHE_INVALID');
  }
  const savedAt = new Date(value.saved_at);
  if (!Number.isFinite(savedAt.valueOf()) || savedAt.toISOString() !== value.saved_at) {
    throw new Error('POLICY_CACHE_INVALID');
  }
  return {
    manifest: parseCurrentPolicyManifest(value),
    savedAt: value.saved_at,
  };
}
