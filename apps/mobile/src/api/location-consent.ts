import type { ApiClient } from './client';
import {
  expectBoolean,
  expectEnum,
  expectIsoDate,
  expectIsoDateTime,
  expectRecord,
  expectString,
  expectUuid,
  invalidPayload,
} from './payload';

import {
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from '@/i18n/locales';

const POLICY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ISO_DATE_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/u;

export type LocationConsentState = 'active' | 'paused' | 'withdrawal_pending';

export type LocationPolicyRequirement = {
  type: 'location_terms';
  version: string;
};

export type LocationConsent = {
  state: LocationConsentState;
  policyVersion: string;
  locale: SupportedLocale;
  consentedAt: string;
  updatedAt: string;
  withdrawalRequestedAt: string | null;
  isCurrent: boolean;
};

export type LocationConsentResult =
  | { status: 'missing'; required: LocationPolicyRequirement | null }
  | { status: 'found'; consent: LocationConsent };

export type LocationWithdrawalResult =
  | { status: 'withdrawn'; erasureJobId: null }
  | { status: 'pending'; erasureJobId: string };

export class LocationConsentRequestError extends Error {
  constructor() {
    super('Location consent request input is invalid.');
    this.name = 'LocationConsentRequestError';
  }
}

function expectExactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const record = expectRecord(value);
  const actual = Object.keys(record);
  if (
    actual.length !== keys.length
    || !actual.every((key) => keys.includes(key))
  ) {
    return invalidPayload();
  }
  return record;
}

function expectPolicyVersion(value: unknown): string {
  return expectString(value, {
    minimumLength: 1,
    maximumLength: 64,
    pattern: POLICY_VERSION_PATTERN,
  });
}

function expectLocationDateTime(value: unknown): string {
  const candidate = expectIsoDateTime(value);
  const match = ISO_DATE_TIME_PATTERN.exec(candidate);
  if (match === null) {
    return invalidPayload();
  }
  expectIsoDate(match[1]);
  return candidate;
}

function parseRequirement(value: unknown): LocationPolicyRequirement | null {
  const record = expectRecord(value);
  if (Object.keys(record).length === 0) {
    return null;
  }
  const exact = expectExactRecord(record, ['type', 'version']);
  if (exact.type !== 'location_terms') {
    return invalidPayload();
  }
  return {
    type: 'location_terms',
    version: expectPolicyVersion(exact.version),
  };
}

function requirePolicyVersion(value: string): string {
  if (!POLICY_VERSION_PATTERN.test(value)) {
    throw new LocationConsentRequestError();
  }
  return value;
}

function requireLocale(value: SupportedLocale): SupportedLocale {
  if (!SUPPORTED_LOCALES.includes(value)) {
    throw new LocationConsentRequestError();
  }
  return value;
}

function requireMutableState(value: 'active' | 'paused'): 'active' | 'paused' {
  if (value !== 'active' && value !== 'paused') {
    throw new LocationConsentRequestError();
  }
  return value;
}

export function parseLocationConsent(value: unknown): LocationConsentResult {
  const record = expectRecord(value);
  const status = expectEnum(record.status, ['missing', 'found'] as const);
  if (status === 'missing') {
    const exact = expectExactRecord(record, ['status', 'required']);
    return { status, required: parseRequirement(exact.required) };
  }

  const exact = expectExactRecord(record, ['status', 'consent']);
  const consent = expectExactRecord(exact.consent, [
    'state',
    'policy_version',
    'locale',
    'consented_at',
    'updated_at',
    'withdrawal_requested_at',
    'is_current',
  ]);
  const state = expectEnum(consent.state, [
    'active',
    'paused',
    'withdrawal_pending',
  ] as const);
  const consentedAt = expectLocationDateTime(consent.consented_at);
  const updatedAt = expectLocationDateTime(consent.updated_at);
  const withdrawalRequestedAt = consent.withdrawal_requested_at === null
    ? null
    : expectLocationDateTime(consent.withdrawal_requested_at);
  if (
    Date.parse(updatedAt) < Date.parse(consentedAt)
    || (state === 'withdrawal_pending') !== (withdrawalRequestedAt !== null)
    || (
      withdrawalRequestedAt !== null
      && Date.parse(withdrawalRequestedAt) < Date.parse(consentedAt)
    )
  ) {
    return invalidPayload();
  }

  return {
    status,
    consent: {
      state,
      policyVersion: expectPolicyVersion(consent.policy_version),
      locale: expectEnum(consent.locale, SUPPORTED_LOCALES),
      consentedAt,
      updatedAt,
      withdrawalRequestedAt,
      isCurrent: expectBoolean(consent.is_current),
    },
  };
}

export function parseLocationWithdrawal(
  value: unknown,
): LocationWithdrawalResult {
  if (value === undefined) {
    return { status: 'withdrawn', erasureJobId: null };
  }
  const record = expectExactRecord(value, ['erasure_job_id']);
  return {
    status: 'pending',
    erasureJobId: expectUuid(record.erasure_job_id),
  };
}

export function createLocationConsentService(client: ApiClient) {
  return {
    async get(signal?: AbortSignal): Promise<LocationConsentResult> {
      const response = await client<unknown>('/api/me/location-consent', {
        authenticated: true,
        ...(signal === undefined ? {} : { signal }),
      });
      return parseLocationConsent(response);
    },

    async accept(input: {
      version: string;
      locale: SupportedLocale;
      signal?: AbortSignal;
    }): Promise<void> {
      const version = requirePolicyVersion(input.version);
      const locale = requireLocale(input.locale);
      await client<void>('/api/me/location-consent', {
        method: 'POST',
        authenticated: true,
        json: { version, locale },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    },

    async setState(input: {
      state: 'active' | 'paused';
      signal?: AbortSignal;
    }): Promise<void> {
      const state = requireMutableState(input.state);
      await client<void>('/api/me/location-consent', {
        method: 'PATCH',
        authenticated: true,
        json: { state },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    },

    async withdraw(signal?: AbortSignal): Promise<LocationWithdrawalResult> {
      const response = await client<unknown>('/api/me/location-consent', {
        method: 'DELETE',
        authenticated: true,
        ...(signal === undefined ? {} : { signal }),
      });
      return parseLocationWithdrawal(response);
    },
  };
}
