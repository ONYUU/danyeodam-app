import type { ApiClient } from './client';
import {
  expectArray,
  expectEnum,
  expectIsoDateTime,
  expectRecord,
  expectString,
  invalidPayload,
} from './payload';

import { SUPPORTED_LOCALES, type SupportedLocale } from '@/i18n/locales';

const POLICY_TYPES = [
  'terms_of_use',
  'privacy_policy',
  'community_guidelines',
  'location_terms',
] as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const POLICY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export type PolicyType = (typeof POLICY_TYPES)[number];
export type PolicyDocument = { url: string; sha256: string };
export type CurrentPolicy = {
  type: PolicyType;
  version: string;
  effectiveAt: string;
  documents: Record<SupportedLocale, PolicyDocument>;
};
export type CurrentPolicyManifest = {
  policies: CurrentPolicy[];
  supportUrl: string | null;
};
export type ConsentPolicyType = 'terms_of_use' | 'community_guidelines';
export type CurrentConsentPolicy = Omit<CurrentPolicy, 'type'> & {
  type: ConsentPolicyType;
};

function expectHttpsUrl(value: unknown): string {
  const candidate = expectString(value, { minimumLength: 8, maximumLength: 2_048 });
  try {
    const parsed = new URL(candidate);
    if (
      parsed.protocol !== 'https:'
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.hash !== ''
    ) {
      return invalidPayload();
    }
    return parsed.toString();
  } catch {
    return invalidPayload();
  }
}

export function parseCurrentPolicyManifest(value: unknown): CurrentPolicyManifest {
  const root = expectRecord(value);
  const policies = expectArray(root.policies, 4);
  if (policies.length !== 4) {
    return invalidPayload();
  }
  const parsed = policies.map((entry) => {
    const policy = expectRecord(entry);
    const documents = expectRecord(policy.documents);
    return {
      type: expectEnum(policy.type, POLICY_TYPES),
      version: expectString(policy.version, {
        minimumLength: 1,
        maximumLength: 64,
        pattern: POLICY_VERSION_PATTERN,
      }),
      effectiveAt: expectIsoDateTime(policy.effective_at),
      documents: Object.fromEntries(SUPPORTED_LOCALES.map((locale) => {
        const document = expectRecord(documents[locale]);
        return [locale, {
          url: expectHttpsUrl(document.url),
          sha256: expectString(document.sha256, {
            minimumLength: 64,
            maximumLength: 64,
            pattern: SHA256_PATTERN,
          }),
        }];
      })) as Record<SupportedLocale, PolicyDocument>,
    };
  });
  if (new Set(parsed.map(({ type }) => type)).size !== POLICY_TYPES.length) {
    return invalidPayload();
  }
  return {
    policies: parsed,
    supportUrl: root.support_url === null ? null : expectHttpsUrl(root.support_url),
  };
}

export function parseCurrentPolicies(value: unknown): CurrentPolicy[] {
  return parseCurrentPolicyManifest(value).policies;
}

export function selectCurrentConsentPolicies(
  policies: readonly CurrentPolicy[],
  locale: SupportedLocale,
): readonly [CurrentConsentPolicy, CurrentConsentPolicy] {
  if (!SUPPORTED_LOCALES.includes(locale)) {
    return invalidPayload();
  }
  const expectedTypes: readonly ConsentPolicyType[] = [
    'terms_of_use',
    'community_guidelines',
  ];
  return expectedTypes.map((type) => {
    const matches = policies.filter((policy) => policy.type === type);
    const policy = matches[0];
    if (matches.length !== 1 || policy === undefined) {
      return invalidPayload();
    }
    const document = policy.documents[locale];
    if (document === undefined) {
      return invalidPayload();
    }
    return { ...policy, type };
  }) as [CurrentConsentPolicy, CurrentConsentPolicy];
}

export function createCurrentPoliciesService(client: ApiClient) {
  const currentManifest = async (
    signal?: AbortSignal,
  ): Promise<CurrentPolicyManifest> => {
    const response = await client<unknown>('/api/policies/current', {
      authenticated: false,
      ...(signal === undefined ? {} : { signal }),
    });
    return parseCurrentPolicyManifest(response);
  };
  return {
    currentManifest,
    async current(signal?: AbortSignal): Promise<CurrentPolicy[]> {
      return (await currentManifest(signal)).policies;
    },
  };
}

export function createPoliciesService(client: ApiClient) {
  const current = createCurrentPoliciesService(client);
  return {
    ...current,
    async accept(input: {
      locale: SupportedLocale;
      policies: readonly CurrentPolicy[];
      signal?: AbortSignal;
    }): Promise<void> {
      const acceptances = selectCurrentConsentPolicies(
        input.policies,
        input.locale,
      ).map((policy) => ({
        type: policy.type,
        version: policy.version,
        locale: input.locale,
      }));
      await client<void>('/api/me/policy-acceptances', {
        method: 'POST',
        json: { acceptances },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    },
  };
}
