import { describe, expect, it } from 'vitest';

import { ApiResponseError, ApiTransportError } from '@/api/client';
import { SensitiveCodeInputError } from '@/api/sensitive-codes';

import { inviteFailure } from './invite-presentation';

function responseError(code: string, status: number) {
  return new ApiResponseError({ code, status, requestId: null, details: null });
}

describe('invite failure projection', () => {
  it('maps strict input, not found, rate limit, auth, and gate failures', () => {
    expect(inviteFailure(new SensitiveCodeInputError('invite'))).toBe('invalid');
    expect(inviteFailure(responseError('VALIDATION_FAILED', 400))).toBe('invalid');
    expect(inviteFailure(responseError('INTERNAL', 400))).toBe('invalid');
    expect(inviteFailure(responseError('NOT_FOUND', 404))).toBe('not_found');
    expect(inviteFailure(responseError('RATE_LIMITED', 429))).toBe('rate_limited');
    expect(inviteFailure(responseError('UNAUTHORIZED', 401))).toBe('session');
    expect(inviteFailure(responseError('FORBIDDEN', 403))).toBe('forbidden');
    expect(inviteFailure(responseError('INTERNAL', 403))).toBe('forbidden');
  });

  it('does not treat an ambiguous transport result as a definitive failure', () => {
    expect(inviteFailure(new ApiTransportError('TIMEOUT'))).toBe('uncertain');
    expect(inviteFailure(new ApiTransportError('AUTH_SESSION_UNAVAILABLE'))).toBe('session');
  });
});
