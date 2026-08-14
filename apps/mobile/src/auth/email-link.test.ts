import type { Session } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { ApiTransportError } from '@/api/client';

import type { PendingEmailLinkStore } from './email-link-pending';
import { EmailLinkStartError, startEmailLink } from './email-link';

const FLOW_ID = '11111111-1111-4111-8111-111111111111';
const AUTH_USER_ID = '22222222-2222-4222-8222-222222222222';

function anonymousSession(): Session {
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_in: 3_600,
    token_type: 'bearer',
    user: {
      id: AUTH_USER_ID,
      is_anonymous: true,
    },
  } as Session;
}

function pendingStore(): PendingEmailLinkStore {
  return {
    save: vi.fn(async () => undefined),
    consume: vi.fn(async () => null),
    clear: vi.fn(async () => undefined),
  };
}

describe('email-link request', () => {
  it('stores only the verifier and posts the normalized email plus challenge', async () => {
    const pending = pendingStore();
    const api = vi.fn(async () => undefined);
    await startEmailLink('  PERSON@Example.COM ', {
      auth: {
        getSession: async () => ({ data: { session: anonymousSession() }, error: null }),
      },
      api,
      pending,
      createPkce: async () => ({
        flowId: FLOW_ID,
        verifier: 'v'.repeat(43),
        challenge: 'c'.repeat(43),
      }),
      now: () => 1_000,
    });

    expect(pending.save).toHaveBeenCalledWith({
      flowId: FLOW_ID,
      verifier: 'v'.repeat(43),
      authUserId: AUTH_USER_ID,
      createdAt: 1_000,
    });
    expect(api).toHaveBeenCalledWith('/api/auth/link-email', {
      method: 'POST',
      authenticated: true,
      json: {
        email: 'person@example.com',
        flow_id: FLOW_ID,
        code_challenge: 'c'.repeat(43),
        code_challenge_method: 's256',
      },
    });
  });

  it('clears the matching verifier if the API request is not accepted', async () => {
    const pending = pendingStore();
    await expect(startEmailLink('person@example.com', {
      auth: {
        getSession: async () => ({ data: { session: anonymousSession() }, error: null }),
      },
      api: async () => {
        throw new Error('network');
      },
      pending,
      createPkce: async () => ({
        flowId: FLOW_ID,
        verifier: 'v'.repeat(43),
        challenge: 'c'.repeat(43),
      }),
    })).rejects.toThrow('network');
    expect(pending.clear).toHaveBeenCalledWith(FLOW_ID);
  });

  it('retains the verifier when transport outcome is ambiguous', async () => {
    const pending = pendingStore();
    await expect(startEmailLink('person@example.com', {
      auth: {
        getSession: async () => ({ data: { session: anonymousSession() }, error: null }),
      },
      api: async () => {
        throw new ApiTransportError('TIMEOUT');
      },
      pending,
      createPkce: async () => ({
        flowId: FLOW_ID,
        verifier: 'v'.repeat(43),
        challenge: 'c'.repeat(43),
      }),
    })).rejects.toMatchObject({ failure: 'TIMEOUT' });
    expect(pending.clear).not.toHaveBeenCalled();
  });

  it('clears the verifier when authentication failed before transport', async () => {
    const pending = pendingStore();
    await expect(startEmailLink('person@example.com', {
      auth: {
        getSession: async () => ({ data: { session: anonymousSession() }, error: null }),
      },
      api: async () => {
        throw new ApiTransportError('AUTH_SESSION_UNAVAILABLE');
      },
      pending,
      createPkce: async () => ({
        flowId: FLOW_ID,
        verifier: 'v'.repeat(43),
        challenge: 'c'.repeat(43),
      }),
    })).rejects.toMatchObject({ failure: 'AUTH_SESSION_UNAVAILABLE' });
    expect(pending.clear).toHaveBeenCalledWith(FLOW_ID);
  });

  it('rejects invalid email and non-anonymous sessions before creating a flow', async () => {
    const createPkce = vi.fn();
    await expect(startEmailLink('not-an-email', {
      auth: { getSession: vi.fn() },
      api: vi.fn(),
      pending: pendingStore(),
      createPkce,
    })).rejects.toEqual(expect.objectContaining<Partial<EmailLinkStartError>>({
      reason: 'INVALID_EMAIL',
    }));
    expect(createPkce).not.toHaveBeenCalled();

    const session = anonymousSession();
    session.user.is_anonymous = false;
    await expect(startEmailLink('person@example.com', {
      auth: { getSession: async () => ({ data: { session }, error: null }) },
      api: vi.fn(),
      pending: pendingStore(),
      createPkce,
    })).rejects.toEqual(expect.objectContaining<Partial<EmailLinkStartError>>({
      reason: 'NOT_ANONYMOUS',
    }));
  });
});
