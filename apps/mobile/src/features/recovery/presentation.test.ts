import { describe, expect, it } from 'vitest';

import { ApiResponseError, ApiTransportError } from '@/api/client';
import { SensitiveCodeInputError } from '@/api/sensitive-codes';

import { recoveryClaimFailure, recoveryIssueFailure } from './presentation';

function responseError(code: string, status: number) {
  return new ApiResponseError({ code, status, requestId: null, details: null });
}

describe('recovery failure projection', () => {
  it('maps issue prerequisites, throttling, and uncertain delivery', () => {
    expect(recoveryIssueFailure(responseError('FORBIDDEN', 403))).toBe('no_acquisition');
    expect(recoveryIssueFailure(responseError('RATE_LIMITED', 429))).toBe('rate_limited');
    expect(recoveryIssueFailure(responseError('UNAUTHORIZED', 401))).toBe('session');
    expect(recoveryIssueFailure(new ApiTransportError('NETWORK_ERROR'))).toBe('uncertain');
  });

  it('maps every specified claim failure without server messages', () => {
    expect(recoveryClaimFailure(new SensitiveCodeInputError('recovery'))).toBe('invalid');
    expect(recoveryClaimFailure(responseError('VALIDATION_FAILED', 400))).toBe('invalid');
    expect(recoveryClaimFailure(responseError('NOT_FOUND', 404))).toBe('not_found');
    expect(recoveryClaimFailure(responseError('RECOVERY_CONFLICT', 409))).toBe('conflict');
    expect(recoveryClaimFailure(responseError('FORBIDDEN', 403))).toBe('forbidden');
    expect(recoveryClaimFailure(responseError('RATE_LIMITED', 429))).toBe('rate_limited');
    expect(recoveryClaimFailure(responseError('UNAUTHORIZED', 401))).toBe('session');
  });
});
