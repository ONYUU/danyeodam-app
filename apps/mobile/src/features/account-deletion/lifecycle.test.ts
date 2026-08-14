import { describe, expect, it, vi } from 'vitest';

import { ApiResponseError, ApiTransportError } from '@/api/client';

import { reconcileAccountDeletion } from './lifecycle';

const credential = {
  requestId: '11111111-1111-4111-8111-111111111111',
  statusToken: 'A'.repeat(43),
};

const pending = {
  id: credential.requestId,
  status: 'pending' as const,
  reasonCode: null,
  requestedAt: '2026-08-12T00:00:00Z',
  completeBy: '2026-08-13T00:00:00Z',
  completedAt: null,
  supportUrl: 'https://support.invalid/delete',
};

function notFound() {
  return new ApiResponseError({
    code: 'NOT_FOUND',
    status: 404,
    requestId: null,
    details: null,
  });
}

function unauthorized() {
  return new ApiResponseError({
    code: 'UNAUTHORIZED',
    status: 401,
    requestId: null,
    details: null,
  });
}

describe('account deletion lifecycle', () => {
  it('uses public status first and never reissues a known request', async () => {
    const request = vi.fn();
    const removeLocalSession = vi.fn(async () => undefined);
    await expect(reconcileAccountDeletion(credential, {
      getStatus: async () => pending,
      request,
      removeLocalSession,
    })).resolves.toMatchObject({ status: 'pending' });
    expect(request).not.toHaveBeenCalled();
    expect(removeLocalSession).toHaveBeenCalledOnce();
  });

  it('replays the exact stored request only after a public 404', async () => {
    const request = vi.fn(async () => ({
      id: credential.requestId,
      status: 'pending' as const,
      requestedAt: pending.requestedAt,
      completeBy: pending.completeBy,
    }));
    await expect(reconcileAccountDeletion(credential, {
      getStatus: async () => { throw notFound(); },
      request,
      removeLocalSession: async () => undefined,
    })).resolves.toEqual({
      status: 'pending',
      reasonCode: null,
      completeBy: pending.completeBy,
      supportUrl: null,
    });
    expect(request).toHaveBeenCalledWith(credential);
  });

  it('recovers a committed request after an ambiguous response loss', async () => {
    const statuses = [notFound(), pending];
    const removeLocalSession = vi.fn(async () => undefined);
    await expect(reconcileAccountDeletion(credential, {
      getStatus: async () => {
        const next = statuses.shift();
        if (next instanceof Error) throw next;
        return next!;
      },
      request: async () => { throw new ApiTransportError('NETWORK_ERROR'); },
      removeLocalSession,
    })).resolves.toMatchObject({ status: 'pending' });
    expect(removeLocalSession).toHaveBeenCalledOnce();
  });

  it('keeps the credential locked when neither request nor status is confirmed', async () => {
    await expect(reconcileAccountDeletion(credential, {
      getStatus: async () => { throw notFound(); },
      request: async () => { throw new ApiTransportError('NETWORK_ERROR'); },
      removeLocalSession: async () => undefined,
    })).rejects.toMatchObject({ failure: 'NETWORK_ERROR' });
  });

  it('offers an explicit local restart only after exact public absence and definitive 401', async () => {
    await expect(reconcileAccountDeletion(credential, {
      getStatus: async () => { throw notFound(); },
      request: async () => { throw unauthorized(); },
      removeLocalSession: async () => undefined,
    })).resolves.toEqual({ status: 'authorization_required' });
  });

  it('handles an expired completed receipt when no authenticated session remains', async () => {
    await expect(reconcileAccountDeletion(credential, {
      getStatus: async () => { throw notFound(); },
      request: async () => { throw new ApiTransportError('AUTH_SESSION_UNAVAILABLE'); },
      removeLocalSession: async () => undefined,
    })).resolves.toEqual({ status: 'authorization_required' });
  });

  it('never clears the lock for a server-side or transport-ambiguous request failure', async () => {
    const internal = new ApiResponseError({
      code: 'INTERNAL',
      status: 500,
      requestId: null,
      details: null,
    });
    await expect(reconcileAccountDeletion(credential, {
      getStatus: async () => { throw notFound(); },
      request: async () => { throw internal; },
      removeLocalSession: async () => undefined,
    })).rejects.toBe(internal);
  });
});
