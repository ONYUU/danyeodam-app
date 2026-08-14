import type { Session } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  signInStoreReviewer,
  type ReviewerPrimaryAuthGateway,
  type ReviewerProbeAuthGateway,
} from './reviewer';

const session = {
  access_token: 'reviewer-access-token',
  refresh_token: 'reviewer-refresh-token',
} as Session;

function probeAuthGateway(): ReviewerProbeAuthGateway {
  return {
    signInWithPassword: vi.fn(async () => ({ data: { session }, error: null })),
    signOut: vi.fn(async () => ({ error: null })),
  };
}

function primaryAuthGateway(): ReviewerPrimaryAuthGateway {
  return {
    setSession: vi.fn(async () => ({ error: null })),
  };
}

describe('store reviewer sign-in', () => {
  it('keeps the session only after the server confirms reviewer membership', async () => {
    const probeAuth = probeAuthGateway();
    const primaryAuth = primaryAuthGateway();
    const fetchMock = vi.fn(async () => Response.json({
      participant: true,
      access_type: 'store_reviewer',
      field_acquisition_requires_location: true,
      fixture_version: 'review-fixture-v1',
    }));

    await expect(signInStoreReviewer({
      email: 'apple-review@example.com',
      password: 'not-logged',
      apiBaseUrl: 'https://api.example.com',
    }, { probeAuth, primaryAuth, fetch: fetchMock })).resolves.toEqual({
      participant: true,
      access_type: 'store_reviewer',
      field_acquisition_requires_location: true,
      fixture_version: 'review-fixture-v1',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://api.example.com/api/me/access'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer reviewer-access-token',
        }),
      }),
    );
    expect(primaryAuth.setSession).toHaveBeenCalledWith({
      access_token: 'reviewer-access-token',
      refresh_token: 'reviewer-refresh-token',
    });
    expect(probeAuth.signOut).not.toHaveBeenCalled();
  });

  it('removes a valid Supabase session that lacks server reviewer membership', async () => {
    const probeAuth = probeAuthGateway();
    const primaryAuth = primaryAuthGateway();
    const fetchMock = vi.fn(async () => Response.json({
      participant: true,
      access_type: 'standard',
      field_acquisition_requires_location: true,
      fixture_version: null,
    }));

    await expect(signInStoreReviewer({
      email: 'ordinary@example.com',
      password: 'not-logged',
      apiBaseUrl: 'https://api.example.com',
    }, { probeAuth, primaryAuth, fetch: fetchMock })).rejects.toThrow(
      'REVIEWER_ACCESS_DENIED',
    );
    expect(probeAuth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(primaryAuth.setSession).not.toHaveBeenCalled();
  });

  it('does not send a request or destroy the current session for invalid credentials', async () => {
    const probeAuth = probeAuthGateway();
    const primaryAuth = primaryAuthGateway();
    probeAuth.signInWithPassword = vi.fn(async () => ({
      data: { session: null },
      error: new Error('invalid credentials'),
    }));
    const fetchMock = vi.fn();

    await expect(signInStoreReviewer({
      email: 'unknown@example.com',
      password: 'wrong',
      apiBaseUrl: 'https://api.example.com',
    }, { probeAuth, primaryAuth, fetch: fetchMock as typeof fetch })).rejects.toThrow(
      'REVIEWER_CREDENTIALS_INVALID',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(probeAuth.signOut).not.toHaveBeenCalled();
    expect(primaryAuth.setSession).not.toHaveBeenCalled();
  });

  it('fails closed and removes the session when access verification is unavailable', async () => {
    const probeAuth = probeAuthGateway();
    const primaryAuth = primaryAuthGateway();
    const fetchMock = vi.fn(async () => {
      throw new Error('network unavailable');
    });

    await expect(signInStoreReviewer({
      email: 'google-review@example.com',
      password: 'not-logged',
      apiBaseUrl: 'https://api.example.com',
    }, { probeAuth, primaryAuth, fetch: fetchMock })).rejects.toThrow(
      'REVIEWER_ACCESS_CHECK_FAILED',
    );
    expect(probeAuth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(primaryAuth.setSession).not.toHaveBeenCalled();
  });

  it('rejects reviewer access without a provisioned fixture version', async () => {
    const probeAuth = probeAuthGateway();
    const primaryAuth = primaryAuthGateway();
    const fetchMock = vi.fn(async () => Response.json({
      participant: true,
      access_type: 'store_reviewer',
      field_acquisition_requires_location: true,
      fixture_version: null,
    }));

    await expect(signInStoreReviewer({
      email: 'apple-review@example.com',
      password: 'not-logged',
      apiBaseUrl: 'https://api.example.com',
    }, { probeAuth, primaryAuth, fetch: fetchMock })).rejects.toThrow(
      'REVIEWER_ACCESS_DENIED',
    );
    expect(primaryAuth.setSession).not.toHaveBeenCalled();
    expect(probeAuth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('preserves the primary session when adopting a reviewer session fails', async () => {
    const probeAuth = probeAuthGateway();
    const primaryAuth = primaryAuthGateway();
    primaryAuth.setSession = vi.fn(async () => ({ error: new Error('invalid session') }));
    const fetchMock = vi.fn(async () => Response.json({
      participant: true,
      access_type: 'store_reviewer',
      field_acquisition_requires_location: true,
      fixture_version: 'review-fixture-v1',
    }));

    await expect(signInStoreReviewer({
      email: 'apple-review@example.com',
      password: 'not-logged',
      apiBaseUrl: 'https://api.example.com',
    }, { probeAuth, primaryAuth, fetch: fetchMock })).rejects.toThrow(
      'REVIEWER_SESSION_ADOPTION_FAILED',
    );
    expect(probeAuth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });
});
