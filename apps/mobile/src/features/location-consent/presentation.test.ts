import { describe, expect, it } from 'vitest';

import type { LocationConsentResult } from '@/api/location-consent';

import { locationConsentPresentation } from './presentation';

function found(input: {
  state: 'active' | 'paused' | 'withdrawal_pending';
  current: boolean;
}): LocationConsentResult {
  return {
    status: 'found',
    consent: {
      state: input.state,
      policyVersion: '2026-08-12',
      locale: 'ko',
      consentedAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      withdrawalRequestedAt: input.state === 'withdrawal_pending'
        ? '2026-08-12T00:00:00.000Z'
        : null,
      isCurrent: input.current,
    },
  };
}

describe('location consent presentation', () => {
  it('requires explicit acceptance for missing and stale consent', () => {
    expect(locationConsentPresentation({ status: 'missing', required: null }))
      .toBe('required');
    expect(locationConsentPresentation(found({ state: 'active', current: false })))
      .toBe('required');
    expect(locationConsentPresentation(found({ state: 'paused', current: false })))
      .toBe('required');
  });

  it('keeps current paused consent separate from explicit resume', () => {
    expect(locationConsentPresentation(found({ state: 'paused', current: true })))
      .toBe('paused');
    expect(locationConsentPresentation(found({ state: 'active', current: true })))
      .toBe('active');
  });

  it('never offers normal controls while withdrawal is pending', () => {
    expect(locationConsentPresentation(found({ state: 'withdrawal_pending', current: false })))
      .toBe('withdrawal_pending');
  });
});
