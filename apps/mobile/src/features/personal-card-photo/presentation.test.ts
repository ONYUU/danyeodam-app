import { describe, expect, it } from 'vitest';

import { ApiResponseError, ApiTransportError } from '@/api/client';
import { PersonalCardUploadError } from '@/api/personal-card-photo';

import { PersonalCardPhotoFlowError } from './coordinator';
import { personalCardPhotoFailure } from './presentation';
import { PersonalCardSelectionError } from './selection';

describe('personal-card photo failure presentation', () => {
  it.each([
    [new PersonalCardSelectionError('TOO_LARGE'), 'too_large'],
    [new PersonalCardSelectionError('UNSUPPORTED_TYPE'), 'unsupported'],
    [new PersonalCardSelectionError('ABORTED'), 'cancelled'],
    [new PersonalCardUploadError('NETWORK_ERROR'), 'uncertain'],
    [new PersonalCardPhotoFlowError('GENERATION_CHANGED'), 'cancelled'],
    [new ApiTransportError('AUTH_SESSION_UNAVAILABLE'), 'session'],
    [new ApiTransportError('TIMEOUT'), 'uncertain'],
  ] as const)('maps %o to %s', (error, expected) => {
    expect(personalCardPhotoFailure(error)).toBe(expected);
  });

  it.each([
    ['RATE_LIMITED', null, 'rate_limited'],
    ['QUOTA_EXCEEDED', null, 'quota'],
    ['POLICY_ACCEPTANCE_REQUIRED', null, 'policy_required'],
    ['LOCATION_CONSENT_REQUIRED', null, 'access_required'],
    ['VALIDATION_FAILED', { reason: 'upload_processing' }, 'processing'],
    ['VALIDATION_FAILED', { reason: 'upload_expired' }, 'expired'],
    ['INTERNAL', null, 'uncertain'],
  ] as const)('maps API code %s safely', (code, details, expected) => {
    expect(personalCardPhotoFailure(new ApiResponseError({
      code,
      status: 400,
      requestId: null,
      details,
    }))).toBe(expected);
  });
});
