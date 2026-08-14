import { describe, expect, it, vi } from 'vitest';

import {
  completeAuthCallback,
  parseAuthCallback,
  parseRejectedAuthCallbackFlowId,
  type AuthCallbackGateway,
} from './callback';

const FLOW_ID = 'abcdef12-abcd-4abc-8def-abcdef123456';
const AUTH_USER_ID = '22222222-2222-4222-8222-222222222222';

function gateway(overrides: Partial<AuthCallbackGateway> = {}): AuthCallbackGateway {
  return {
    consumePending: vi.fn(async () => ({
      verifier: 'a'.repeat(43),
      authUserId: AUTH_USER_ID,
    })),
    exchangeCode: vi.fn(async () => ({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      authUserId: AUTH_USER_ID,
    })),
    setSession: vi.fn(async () => ({
      data: { session: { user: { id: AUTH_USER_ID } } },
      error: null,
    })),
    clearSession: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('native auth callback', () => {
  it('consumes the exact flow before exchanging and adopts only the same user', async () => {
    const auth = gateway();
    await completeAuthCallback(
      `danyeodam://auth/callback?code=one-time-code&sb_flow_id=${FLOW_ID}`,
      auth,
    );
    expect(auth.consumePending).toHaveBeenCalledWith(FLOW_ID);
    expect(auth.exchangeCode).toHaveBeenCalledWith('one-time-code', 'a'.repeat(43));
    expect(auth.setSession).toHaveBeenCalledWith({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
    });
    expect(auth.clearSession).not.toHaveBeenCalled();
  });

  it('rejects a callback without its one-use pending verifier', async () => {
    const auth = gateway({ consumePending: vi.fn(async () => null) });
    await expect(completeAuthCallback(
      `danyeodam://auth/callback?code=one-time-code&sb_flow_id=${FLOW_ID}`,
      auth,
    )).rejects.toThrow('AUTH_CALLBACK_FLOW_NOT_FOUND');
    expect(auth.exchangeCode).not.toHaveBeenCalled();
  });

  it('never adopts tokens issued for a different auth user', async () => {
    const auth = gateway({
      exchangeCode: vi.fn(async () => ({
        accessToken: 'attacker-access',
        refreshToken: 'attacker-refresh',
        authUserId: '33333333-3333-4333-8333-333333333333',
      })),
    });
    await expect(completeAuthCallback(
      `danyeodam://auth/callback?code=one-time-code&sb_flow_id=${FLOW_ID}`,
      auth,
    )).rejects.toThrow('AUTH_CALLBACK_USER_MISMATCH');
    expect(auth.setSession).not.toHaveBeenCalled();
  });

  it('clears a partially adopted session when the SDK result is invalid', async () => {
    const auth = gateway({
      setSession: vi.fn(async () => ({ data: { session: null }, error: new Error('bad') })),
    });
    await expect(completeAuthCallback(
      `danyeodam://auth/callback?code=one-time-code&sb_flow_id=${FLOW_ID}`,
      auth,
    )).rejects.toThrow('AUTH_CALLBACK_EXCHANGE_FAILED');
    expect(auth.clearSession).toHaveBeenCalledOnce();
  });

  it('rejects other schemes, paths, implicit tokens, duplicate and unknown fields', () => {
    expect(() => parseAuthCallback('https://evil.example/auth/callback?code=x')).toThrow(
      'AUTH_CALLBACK_NOT_ALLOWED',
    );
    expect(() => parseAuthCallback('danyeodam://auth/other?code=x')).toThrow(
      'AUTH_CALLBACK_NOT_ALLOWED',
    );
    expect(() => parseAuthCallback(
      `danyeodam://auth/callback?code=x&sb_flow_id=${FLOW_ID}#access_token=a&refresh_token=r`,
    )).toThrow('AUTH_CALLBACK_INVALID');
    expect(() => parseAuthCallback(
      'danyeodam://auth/callback#access_token=a&refresh_token=r&type=email_change',
    )).toThrow('AUTH_CALLBACK_INVALID');
    expect(() => parseAuthCallback(
      'danyeodam://auth/callback?error=access_denied&error_description=secret',
    )).toThrow('AUTH_CALLBACK_REJECTED');
    expect(() => parseAuthCallback('danyeodam://auth/callback?code=x')).toThrow(
      'AUTH_CALLBACK_INVALID',
    );
    expect(() => parseAuthCallback(
      `danyeodam://auth/callback?code=x&code=y&sb_flow_id=${FLOW_ID}`,
    )).toThrow('AUTH_CALLBACK_INVALID');
    expect(() => parseAuthCallback(
      `danyeodam://auth/callback?code=x&sb_flow_id=${FLOW_ID}&redirect=https://evil.example`,
    )).toThrow('AUTH_CALLBACK_INVALID');
    expect(() => parseAuthCallback(
      `danyeodam://auth/callback?code=x&sb_flow_id=${FLOW_ID.toUpperCase()}`,
    )).toThrow('AUTH_CALLBACK_INVALID');
  });

  it('extracts only a correlated flow from a strict rejected callback', () => {
    expect(parseRejectedAuthCallbackFlowId(
      `danyeodam://auth/callback?error=access_denied&error_code=otp_expired&sb_flow_id=${FLOW_ID}`,
    )).toBe(FLOW_ID);
    expect(parseRejectedAuthCallbackFlowId(
      `danyeodam://auth/callback?error=access_denied&sb_flow_id=${FLOW_ID}&redirect=evil`,
    )).toBeNull();
    expect(parseRejectedAuthCallbackFlowId(
      `https://evil.example/auth/callback?error=access_denied&sb_flow_id=${FLOW_ID}`,
    )).toBeNull();
  });
});
