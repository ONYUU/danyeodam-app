import { describe, expect, it } from 'vitest';

import { ApiResponseError } from '@/api/client';

import { formatRateLimitRetryAfter } from './rate-limit';

const templates = {
  seconds: 'Retry in {count} seconds.',
  minutes: 'Retry in {count} minutes.',
};

describe('rate-limit retry projection', () => {
  it('uses sanitized Retry-After seconds when available', () => {
    const error = new ApiResponseError({
      code: 'RATE_LIMITED',
      status: 429,
      requestId: null,
      details: { retry_after_seconds: 42, locked_minutes: 3 },
    });

    expect(formatRateLimitRetryAfter(error, 'en', templates)).toBe(
      'Retry in 42 seconds.',
    );
  });

  it('falls back to a server lock duration and ignores unrelated errors', () => {
    const lock = new ApiResponseError({
      code: 'RATE_LIMITED',
      status: 429,
      requestId: null,
      details: { locked_minutes: 10 },
    });
    const unrelated = new ApiResponseError({
      code: 'NOT_FOUND',
      status: 404,
      requestId: null,
      details: null,
    });

    expect(formatRateLimitRetryAfter(lock, 'ko', templates)).toBe(
      'Retry in 10 minutes.',
    );
    expect(formatRateLimitRetryAfter(unrelated, 'en', templates)).toBeNull();
  });
});
