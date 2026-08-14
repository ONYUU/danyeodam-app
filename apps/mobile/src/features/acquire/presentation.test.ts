import { describe, expect, it } from 'vitest';

import { ApiResponseError, ApiTransportError } from '@/api/client';
import { ForegroundLocationError } from '@/platform/foreground-location';

import { AcquireFlowError } from './coordinator';
import { acquireFailure } from './presentation';

function responseError(
  code: string,
  status: number,
  details: Record<string, unknown> | null = null,
) {
  return new ApiResponseError({ code, status, requestId: null, details });
}

describe('acquisition failure projection', () => {
  it('projects location failures without exposing device data', () => {
    expect(acquireFailure(new ForegroundLocationError('PERMISSION_DENIED_RETRYABLE')))
      .toBe('permission_denied');
    expect(acquireFailure(new ForegroundLocationError('PERMISSION_DENIED_SETTINGS')))
      .toBe('permission_settings');
    expect(acquireFailure(new ForegroundLocationError('APPROXIMATE_PERMISSION')))
      .toBe('approximate_location');
    expect(acquireFailure(new ForegroundLocationError('TIMEOUT')))
      .toBe('location_timeout');
    expect(acquireFailure(new ForegroundLocationError('UNAVAILABLE')))
      .toBe('location_unavailable');
  });

  it('projects the allowed acquisition error codes', () => {
    expect(acquireFailure(responseError('LOW_ACCURACY', 422, { retry: true })))
      .toBe('low_accuracy');
    expect(acquireFailure(responseError('OUT_OF_RANGE', 422, { distance_band: 'near' })))
      .toBe('out_of_range_near');
    expect(acquireFailure(responseError('OUT_OF_RANGE', 422, { distance_band: 'far' })))
      .toBe('out_of_range_far');
    expect(acquireFailure(responseError('ALREADY_ACQUIRED_TODAY', 409)))
      .toBe('already_today');
    expect(acquireFailure(responseError('SPOT_NOT_OPEN', 422)))
      .toBe('spot_not_open');
    expect(acquireFailure(responseError('GATE_CLOSED', 403)))
      .toBe('gate_closed');
    expect(acquireFailure(responseError('MINIMUM_AGE_ATTESTATION_REQUIRED', 428)))
      .toBe('minimum_age_required');
    expect(acquireFailure(responseError('LOCATION_CONSENT_REQUIRED', 428)))
      .toBe('location_consent_required');
    expect(acquireFailure(responseError('LOCATION_USE_PAUSED', 403)))
      .toBe('location_use_paused');
    expect(acquireFailure(responseError('LOCATION_WITHDRAWAL_PENDING', 409)))
      .toBe('location_withdrawal_pending');
    expect(acquireFailure(responseError('LOCATION_CORRECTION_PENDING', 409)))
      .toBe('location_correction_pending');
    expect(acquireFailure(new AcquireFlowError('LOCATION_CONSENT_REQUIRED')))
      .toBe('location_consent_required');
  });

  it('separates session loss from an ambiguous transport retry', () => {
    expect(acquireFailure(new ApiTransportError('AUTH_SESSION_UNAVAILABLE')))
      .toBe('session');
    expect(acquireFailure(new ApiTransportError('TIMEOUT'))).toBe('uncertain');
    expect(acquireFailure(responseError('UNAUTHORIZED', 401))).toBe('session');
  });
});
