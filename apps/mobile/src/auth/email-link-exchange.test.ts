import { describe, expect, it, vi } from 'vitest';

import { createEmailLinkCodeExchange } from './email-link-exchange';

const AUTH_USER_ID = '11111111-1111-4111-8111-111111111111';

describe('email-link PKCE code exchange', () => {
  it('posts the code and verifier only to the fixed Supabase token endpoint', async () => {
    const requestFetch = vi.fn(async () => Response.json({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      user: { id: AUTH_USER_ID },
    }));
    const exchange = createEmailLinkCodeExchange({
      supabaseUrl: 'https://project.supabase.co',
      publishableKey: 'publishable-key',
      fetch: requestFetch,
    });

    await expect(exchange('one-time-code', 'v'.repeat(43))).resolves.toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      authUserId: AUTH_USER_ID,
    });
    expect(requestFetch).toHaveBeenCalledWith(
      new URL('https://project.supabase.co/auth/v1/token?grant_type=pkce'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          apikey: 'publishable-key',
          Authorization: 'Bearer publishable-key',
        }),
        body: JSON.stringify({
          auth_code: 'one-time-code',
          code_verifier: 'v'.repeat(43),
        }),
        cache: 'no-store',
      }),
    );
  });

  it('never puts a new-format publishable key in the bearer header', async () => {
    const requestFetch = vi.fn(async () => Response.json({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      user: { id: AUTH_USER_ID },
    }));
    const exchange = createEmailLinkCodeExchange({
      supabaseUrl: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_example',
      fetch: requestFetch,
    });
    await exchange('one-time-code', 'v'.repeat(43));

    expect(requestFetch).toHaveBeenCalledWith(
      new URL('https://project.supabase.co/auth/v1/token?grant_type=pkce'),
      expect.objectContaining({
        headers: {
          Accept: 'application/json',
          apikey: 'sb_publishable_example',
          'Content-Type': 'application/json',
        },
      }),
    );
  });

  it('fails closed for errors and malformed token responses', async () => {
    const serverError = createEmailLinkCodeExchange({
      supabaseUrl: 'https://project.supabase.co',
      publishableKey: 'publishable-key',
      fetch: async () => Response.json({ error: 'secret-detail' }, { status: 400 }),
    });
    await expect(serverError('code', 'v'.repeat(43))).rejects.toThrow(
      'AUTH_CALLBACK_EXCHANGE_FAILED',
    );

    const malformed = createEmailLinkCodeExchange({
      supabaseUrl: 'https://project.supabase.co',
      publishableKey: 'publishable-key',
      fetch: async () => Response.json({ access_token: 'only-one-token' }),
    });
    await expect(malformed('code', 'v'.repeat(43))).rejects.toThrow(
      'AUTH_CALLBACK_EXCHANGE_FAILED',
    );

    const requestFetch = vi.fn();
    const invalidVerifier = createEmailLinkCodeExchange({
      supabaseUrl: 'https://project.supabase.co',
      publishableKey: 'publishable-key',
      fetch: requestFetch,
    });
    await expect(invalidVerifier('code', 'too-short')).rejects.toThrow(
      'AUTH_CALLBACK_EXCHANGE_FAILED',
    );
    expect(requestFetch).not.toHaveBeenCalled();
  });
});
