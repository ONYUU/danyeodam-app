import { describe, expect, it } from 'vitest';

import { resolveAttestationPresentation } from './attestation-presentation';

describe('minimum-age attestation presentation', () => {
  it('keeps app content closed with retry UI after a protected 401 signs out', () => {
    expect(resolveAttestationPresentation({
      authStatus: 'signed_out',
      hasSession: false,
      requestState: 'waiting',
    })).toBe('session_error');
  });

  it('keeps app content closed with retry UI after a network failure', () => {
    expect(resolveAttestationPresentation({
      authStatus: 'ready',
      hasSession: true,
      requestState: 'error',
    })).toBe('request_error');
  });

  it('opens content only after auth and attestation are both ready', () => {
    expect(resolveAttestationPresentation({
      authStatus: 'ready',
      hasSession: true,
      requestState: 'submitting',
    })).toBe('loading');
    expect(resolveAttestationPresentation({
      authStatus: 'ready',
      hasSession: true,
      requestState: 'ready',
    })).toBe('ready');
  });
});
