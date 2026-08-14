import { describe, expect, it, vi } from 'vitest';

import { ApiResponseError, ApiTransportError } from '@/api/client';

import {
  correctionAttemptFor,
  shouldRetainCorrectionAttempt,
} from './correction-attempt';

describe('location correction retry identity', () => {
  it('reuses the request id only for the same subject and reason', () => {
    const createClientRequestId = vi.fn(() => '22222222-2222-4222-8222-222222222222');
    const previous = {
      subject: 'fact:1',
      reason: 'incorrect_outcome' as const,
      clientRequestId: '11111111-1111-4111-8111-111111111111',
    };
    expect(correctionAttemptFor({
      previous,
      subject: 'fact:1',
      reason: 'incorrect_outcome',
      createClientRequestId,
    })).toBe(previous);
    expect(createClientRequestId).not.toHaveBeenCalled();

    expect(correctionAttemptFor({
      previous,
      subject: 'fact:1',
      reason: 'other',
      createClientRequestId,
    }).clientRequestId).toBe('22222222-2222-4222-8222-222222222222');
    expect(createClientRequestId).toHaveBeenCalledOnce();
  });

  it('retains the id after transport or server-ambiguous failures only', () => {
    expect(shouldRetainCorrectionAttempt(new ApiTransportError('TIMEOUT'))).toBe(true);
    expect(shouldRetainCorrectionAttempt(new ApiResponseError({
      code: 'INTERNAL',
      status: 500,
      requestId: null,
      details: null,
    }))).toBe(true);
    expect(shouldRetainCorrectionAttempt(new ApiResponseError({
      code: 'IDEMPOTENCY_CONFLICT',
      status: 409,
      requestId: null,
      details: null,
    }))).toBe(false);
  });
});
