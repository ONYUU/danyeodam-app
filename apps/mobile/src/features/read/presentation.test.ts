import { describe, expect, it } from 'vitest';

import { ApiResponseError, ApiTransportError } from '@/api/client';

import {
  acquisitionGlyph,
  classifyReadError,
  formatKstDate,
} from './presentation';

describe('read presentation helpers', () => {
  it('separates offline, session, and generic failures', () => {
    expect(classifyReadError(new ApiTransportError('NETWORK_ERROR'))).toBe('offline');
    expect(classifyReadError(new ApiTransportError('TIMEOUT'))).toBe('offline');
    expect(classifyReadError(new ApiTransportError('AUTH_SESSION_UNAVAILABLE'))).toBe('session');
    expect(classifyReadError(new ApiResponseError({
      code: 'UNAUTHORIZED',
      status: 401,
      requestId: null,
      details: null,
    }))).toBe('session');
    expect(classifyReadError(new Error('unknown'))).toBe('generic');
  });

  it('formats the server-provided KST date without a local-day shift', () => {
    expect(formatKstDate('2026-08-12', 'ko')).toContain('2026');
    expect(formatKstDate('not-a-date', 'en')).toBe('not-a-date');
  });

  it('uses the fixed non-ranking acquisition marks', () => {
    expect(acquisitionGlyph('field')).toBe('●');
    expect(acquisitionGlyph('retro')).toBe('◌');
    expect(acquisitionGlyph('gift')).toBe('◇');
  });
});
