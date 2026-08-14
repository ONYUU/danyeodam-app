import type { Session } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { restoreExistingPrivacyRightsSession } from './privacy-rights-session';

const existingSession = {
  access_token: 'stored-access-token',
  user: { id: '11111111-1111-4111-8111-111111111111' },
} as Session;

describe('restricted privacy-rights session restoration', () => {
  it('returns an existing stored session without creating an anonymous user', async () => {
    const signInAnonymously = vi.fn();
    const auth = {
      getSession: vi.fn(async () => ({
        data: { session: existingSession },
        error: null,
      })),
      signInAnonymously,
    };

    await expect(restoreExistingPrivacyRightsSession(auth))
      .resolves.toBe(existingSession);
    expect(auth.getSession).toHaveBeenCalledOnce();
    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it('does not define a token-bearing capability projection', async () => {
    const providerSource = await import('node:fs').then(({ readFileSync }) => (
      readFileSync(
        new URL('./privacy-rights-session-provider.tsx', import.meta.url),
        'utf8',
      )
    ));

    expect(providerSource).not.toMatch(/accessToken|access_token/gu);
    expect(providerSource).toContain('userId: session.user.id');
  });

  it('returns no capability when this device has no stored session', async () => {
    const signInAnonymously = vi.fn();
    const auth = {
      getSession: vi.fn(async () => ({
        data: { session: null },
        error: null,
      })),
      signInAnonymously,
    };

    await expect(restoreExistingPrivacyRightsSession(auth)).resolves.toBeNull();
    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it('fails closed on a storage or Auth read error', async () => {
    const signInAnonymously = vi.fn();
    const auth = {
      getSession: vi.fn(async () => ({
        data: { session: null },
        error: new Error('private gateway detail'),
      })),
      signInAnonymously,
    };

    await expect(restoreExistingPrivacyRightsSession(auth))
      .rejects.toThrow('PRIVACY_RIGHTS_SESSION_RESTORE_FAILED');
    expect(signInAnonymously).not.toHaveBeenCalled();
  });
});
