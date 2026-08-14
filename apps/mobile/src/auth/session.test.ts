import type { Session } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  removeLocalSession,
  restoreOrCreateAnonymousSession,
  type SessionAuthGateway,
} from './session';

const session = { access_token: 'access' } as Session;

function gateway(overrides: Partial<SessionAuthGateway> = {}): SessionAuthGateway {
  return {
    getSession: vi.fn(async () => ({ data: { session }, error: null })),
    signInAnonymously: vi.fn(async () => ({ data: { session }, error: null })),
    signOut: vi.fn(async () => ({ error: null })),
    ...overrides,
  };
}

describe('mobile auth session lifecycle', () => {
  it('reuses an existing session without creating a second anonymous user', async () => {
    const auth = gateway();
    await expect(restoreOrCreateAnonymousSession(auth)).resolves.toBe(session);
    expect(auth.signInAnonymously).not.toHaveBeenCalled();
  });

  it('creates an anonymous session on first launch', async () => {
    const auth = gateway({
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
    });
    await expect(restoreOrCreateAnonymousSession(auth)).resolves.toBe(session);
    expect(auth.signInAnonymously).toHaveBeenCalledOnce();
  });

  it('does not pretend authentication succeeded when creation fails', async () => {
    const auth = gateway({
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      signInAnonymously: vi.fn(async () => ({
        data: { session: null },
        error: new Error('offline'),
      })),
    });
    await expect(restoreOrCreateAnonymousSession(auth)).rejects.toThrow(
      'AUTH_ANONYMOUS_SIGN_IN_FAILED',
    );
  });

  it('uses local sign-out when a protected API rejects a stale binding', async () => {
    const auth = gateway();
    await removeLocalSession(auth);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });
});
