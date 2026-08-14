import { ApiResponseError, ApiTransportError } from '@/api/client';
import { ForegroundLocationError } from '@/platform/foreground-location';

import { AcquireFlowError } from './coordinator';

export type AcquireFailure =
  | 'permission_denied'
  | 'permission_settings'
  | 'approximate_location'
  | 'location_timeout'
  | 'location_unavailable'
  | 'low_accuracy'
  | 'out_of_range_near'
  | 'out_of_range_far'
  | 'already_today'
  | 'spot_not_open'
  | 'gate_closed'
  | 'minimum_age_required'
  | 'location_consent_required'
  | 'location_use_paused'
  | 'location_withdrawal_pending'
  | 'location_correction_pending'
  | 'session'
  | 'uncertain'
  | 'error';

export function acquireFailure(error: unknown): AcquireFailure {
  if (error instanceof AcquireFlowError) {
    if (error.reason === 'LOCATION_CONSENT_REQUIRED') {
      return 'location_consent_required';
    }
    if (error.reason === 'LOCATION_USE_PAUSED') {
      return 'location_use_paused';
    }
    if (error.reason === 'LOCATION_WITHDRAWAL_PENDING') {
      return 'location_withdrawal_pending';
    }
  }
  if (error instanceof ForegroundLocationError) {
    if (error.reason === 'PERMISSION_DENIED_RETRYABLE') {
      return 'permission_denied';
    }
    if (error.reason === 'PERMISSION_DENIED_SETTINGS') {
      return 'permission_settings';
    }
    if (error.reason === 'APPROXIMATE_PERMISSION') {
      return 'approximate_location';
    }
    if (error.reason === 'TIMEOUT') {
      return 'location_timeout';
    }
    return 'location_unavailable';
  }
  if (error instanceof ApiTransportError) {
    return error.failure === 'AUTH_SESSION_UNAVAILABLE' ? 'session' : 'uncertain';
  }
  if (error instanceof ApiResponseError) {
    if (error.status === 401 || error.code === 'UNAUTHORIZED') {
      return 'session';
    }
    if (error.code === 'LOW_ACCURACY') {
      return 'low_accuracy';
    }
    if (error.code === 'OUT_OF_RANGE') {
      return error.details?.distance_band === 'near'
        ? 'out_of_range_near'
        : 'out_of_range_far';
    }
    if (error.code === 'ALREADY_ACQUIRED_TODAY') {
      return 'already_today';
    }
    if (error.code === 'SPOT_NOT_OPEN') {
      return 'spot_not_open';
    }
    if (error.code === 'GATE_CLOSED' || error.code === 'FORBIDDEN') {
      return 'gate_closed';
    }
    if (error.code === 'MINIMUM_AGE_ATTESTATION_REQUIRED') {
      return 'minimum_age_required';
    }
    if (error.code === 'LOCATION_CONSENT_REQUIRED') {
      return 'location_consent_required';
    }
    if (error.code === 'LOCATION_USE_PAUSED') {
      return 'location_use_paused';
    }
    if (error.code === 'LOCATION_WITHDRAWAL_PENDING') {
      return 'location_withdrawal_pending';
    }
    if (error.code === 'LOCATION_CORRECTION_PENDING') {
      return 'location_correction_pending';
    }
  }
  return 'error';
}
