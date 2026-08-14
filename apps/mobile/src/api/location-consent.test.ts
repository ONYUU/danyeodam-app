import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from './client';
import { ApiTransportError } from './client';
import {
  LocationConsentRequestError,
  createLocationConsentService,
  parseLocationConsent,
  parseLocationWithdrawal,
} from './location-consent';

const consent = {
  state: 'active',
  policy_version: 'location-2026.08',
  locale: 'ko',
  consented_at: '2026-08-12T01:00:00.000Z',
  updated_at: '2026-08-12T01:01:00.000Z',
  withdrawal_requested_at: null,
  is_current: true,
};

describe('location consent service', () => {
  it('parses both canonical missing-policy projections', () => {
    expect(parseLocationConsent({
      status: 'missing',
      required: { type: 'location_terms', version: 'location-2026.08' },
    })).toEqual({
      status: 'missing',
      required: { type: 'location_terms', version: 'location-2026.08' },
    });
    expect(parseLocationConsent({ status: 'missing', required: {} })).toEqual({
      status: 'missing',
      required: null,
    });
  });

  it('parses an active consent into the bounded mobile projection', () => {
    expect(parseLocationConsent({ status: 'found', consent })).toEqual({
      status: 'found',
      consent: {
        state: 'active',
        policyVersion: 'location-2026.08',
        locale: 'ko',
        consentedAt: '2026-08-12T01:00:00.000Z',
        updatedAt: '2026-08-12T01:01:00.000Z',
        withdrawalRequestedAt: null,
        isCurrent: true,
      },
    });
  });

  it('accepts withdrawal only with a valid request time', () => {
    expect(parseLocationConsent({
      status: 'found',
      consent: {
        ...consent,
        state: 'withdrawal_pending',
        withdrawal_requested_at: '2026-08-12T01:02:00+00:00',
      },
    })).toMatchObject({
      status: 'found',
      consent: {
        state: 'withdrawal_pending',
        withdrawalRequestedAt: '2026-08-12T01:02:00+00:00',
      },
    });

    for (const malformed of [
      { ...consent, state: 'withdrawal_pending' },
      { ...consent, withdrawal_requested_at: '2026-08-12T01:02:00Z' },
      { ...consent, updated_at: '2026-08-11T23:59:59Z' },
    ]) {
      expect(() => parseLocationConsent({
        status: 'found',
        consent: malformed,
      })).toThrow(ApiTransportError);
    }
  });

  it('rejects unknown fields, raw coordinates, bad locales, and invalid dates', () => {
    for (const malformed of [
      { ...consent, latitude: 37.5 },
      { ...consent, locale: 'fr' },
      { ...consent, consented_at: '2026-02-30T01:00:00Z' },
      { ...consent, policy_version: '../location' },
    ]) {
      expect(() => parseLocationConsent({
        status: 'found',
        consent: malformed,
      })).toThrow(ApiTransportError);
    }
    expect(() => parseLocationConsent({
      status: 'missing',
      required: { type: 'location_terms', version: 'v1', longitude: 127 },
    })).toThrow(ApiTransportError);
  });

  it('distinguishes immediate withdrawal from a strict async erasure receipt', () => {
    expect(parseLocationWithdrawal(undefined)).toEqual({
      status: 'withdrawn',
      erasureJobId: null,
    });
    expect(parseLocationWithdrawal({
      erasure_job_id: '11111111-1111-4111-8111-111111111111',
    })).toEqual({
      status: 'pending',
      erasureJobId: '11111111-1111-4111-8111-111111111111',
    });
    expect(() => parseLocationWithdrawal({
      erasure_job_id: 'not-a-uuid',
    })).toThrow(ApiTransportError);
    expect(() => parseLocationWithdrawal({
      erasure_job_id: '11111111-1111-4111-8111-111111111111',
      object_path: 'private/path',
    })).toThrow(ApiTransportError);
  });

  it('uses the authenticated route with exact accept, pause, and withdrawal methods', async () => {
    const responses: unknown[] = [
      { status: 'found', consent },
      undefined,
      undefined,
      { erasure_job_id: '11111111-1111-4111-8111-111111111111' },
    ];
    const client = vi.fn(async () => responses.shift());
    const service = createLocationConsentService(client as unknown as ApiClient);

    await expect(service.get()).resolves.toMatchObject({ status: 'found' });
    await expect(service.accept({
      version: 'location-2026.08',
      locale: 'ja',
    })).resolves.toBeUndefined();
    await expect(service.setState({ state: 'paused' })).resolves.toBeUndefined();
    await expect(service.withdraw()).resolves.toMatchObject({ status: 'pending' });

    expect(client.mock.calls).toEqual([
      ['/api/me/location-consent', { authenticated: true }],
      ['/api/me/location-consent', {
        method: 'POST',
        authenticated: true,
        json: { version: 'location-2026.08', locale: 'ja' },
      }],
      ['/api/me/location-consent', {
        method: 'PATCH',
        authenticated: true,
        json: { state: 'paused' },
      }],
      ['/api/me/location-consent', {
        method: 'DELETE',
        authenticated: true,
      }],
    ]);
  });

  it('rejects invalid mutation input before reaching the authenticated client', async () => {
    const client = vi.fn();
    const service = createLocationConsentService(client as unknown as ApiClient);

    await expect(service.accept({
      version: '../private',
      locale: 'ko',
    })).rejects.toBeInstanceOf(LocationConsentRequestError);
    await expect(service.accept({
      version: 'location-v1',
      locale: 'fr' as 'ko',
    })).rejects.toBeInstanceOf(LocationConsentRequestError);
    await expect(service.setState({
      state: 'withdrawal_pending' as 'active',
    })).rejects.toBeInstanceOf(LocationConsentRequestError);
    expect(client).not.toHaveBeenCalled();
  });
});
