import {
  ApiResponseError,
  ApiTransportError,
} from '@/api/client';
import { PersonalCardUploadError } from '@/api/personal-card-photo';

import { PersonalCardPhotoFlowError } from './coordinator';
import { PersonalCardSelectionError } from './selection';

export type PersonalCardPhotoFailure =
  | 'access_required'
  | 'cancelled'
  | 'error'
  | 'expired'
  | 'processing'
  | 'policy_required'
  | 'quota'
  | 'rate_limited'
  | 'session'
  | 'too_large'
  | 'uncertain'
  | 'unsupported';

export function personalCardPhotoFailure(error: unknown): PersonalCardPhotoFailure {
  if (error instanceof PersonalCardPhotoFlowError) {
    if (error.reason === 'CANCELLED' || error.reason === 'GENERATION_CHANGED') {
      return 'cancelled';
    }
    return 'error';
  }
  if (error instanceof PersonalCardSelectionError) {
    if (error.reason === 'ABORTED') {
      return 'cancelled';
    }
    if (error.reason === 'TOO_LARGE') {
      return 'too_large';
    }
    if (error.reason === 'UNSUPPORTED_TYPE') {
      return 'unsupported';
    }
    return 'error';
  }
  if (error instanceof PersonalCardUploadError) {
    if (error.reason === 'ABORTED') {
      return 'cancelled';
    }
    if (error.reason === 'NETWORK_ERROR' || error.reason === 'TIMEOUT') {
      return 'uncertain';
    }
    return 'error';
  }
  if (error instanceof ApiTransportError) {
    if (error.failure === 'ABORTED') {
      return 'cancelled';
    }
    if (error.failure === 'AUTH_SESSION_UNAVAILABLE') {
      return 'session';
    }
    return error.failure === 'INVALID_RESPONSE' ? 'error' : 'uncertain';
  }
  if (error instanceof ApiResponseError) {
    if (error.status === 401 || error.code === 'UNAUTHORIZED') {
      return 'session';
    }
    if (error.code === 'RATE_LIMITED') {
      return 'rate_limited';
    }
    if (error.code === 'QUOTA_EXCEEDED') {
      return 'quota';
    }
    if (error.code === 'POLICY_ACCEPTANCE_REQUIRED') {
      return 'policy_required';
    }
    if (
      error.code === 'GATE_CLOSED'
      || error.code === 'FORBIDDEN'
      || error.code === 'MINIMUM_AGE_ATTESTATION_REQUIRED'
      || error.code === 'LOCATION_CONSENT_REQUIRED'
      || error.code === 'LOCATION_USE_PAUSED'
      || error.code === 'LOCATION_WITHDRAWAL_PENDING'
      || error.code === 'LOCATION_CORRECTION_PENDING'
    ) {
      return 'access_required';
    }
    if (
      error.code === 'VALIDATION_FAILED'
      && error.details?.reason === 'upload_processing'
    ) {
      return 'processing';
    }
    if (
      error.code === 'VALIDATION_FAILED'
      && error.details?.reason === 'upload_expired'
    ) {
      return 'expired';
    }
    if (error.code === 'INTERNAL') {
      return 'uncertain';
    }
  }
  return 'error';
}
