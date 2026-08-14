import { describe, expect, it, vi } from 'vitest';

import { ApiTransportError, type ApiClient } from './client';
import {
  createAccountDeletionService,
  parseAccountDeletionAccepted,
  parseAccountDeletionStatus,
} from './account-deletion';

const credential = {
  requestId: '11111111-1111-4111-8111-111111111111',
  statusToken: 'A'.repeat(43),
};

const accepted = {
  deletion_request: {
    id: credential.requestId,
    status: 'pending',
    requested_at: '2026-08-12T00:00:00Z',
    complete_by: '2026-08-13T00:00:00Z',
  },
};

const pending = {
  id: credential.requestId,
  status: 'pending',
  reason_code: 'retrying',
  requested_at: '2026-08-12T00:00:00Z',
  complete_by: '2026-08-13T00:00:00Z',
  completed_at: null,
  support_url: 'https://support.danyeodam.invalid/account-delete',
};

describe('account deletion API', () => {
  it('strictly parses accepted and public status projections', () => {
    expect(parseAccountDeletionAccepted(accepted)).toEqual({
      id: credential.requestId,
      status: 'pending',
      requestedAt: '2026-08-12T00:00:00Z',
      completeBy: '2026-08-13T00:00:00Z',
    });
    expect(parseAccountDeletionStatus(pending)).toEqual({
      id: credential.requestId,
      status: 'pending',
      reasonCode: 'retrying',
      requestedAt: '2026-08-12T00:00:00Z',
      completeBy: '2026-08-13T00:00:00Z',
      completedAt: null,
      supportUrl: 'https://support.danyeodam.invalid/account-delete',
    });
  });

  it.each([
    { ...accepted, extra: true },
    { deletion_request: { ...accepted.deletion_request, id: 'not-a-uuid' } },
    { deletion_request: { ...accepted.deletion_request, complete_by: accepted.deletion_request.requested_at } },
  ])('rejects malformed accepted projections', (payload) => {
    expect(() => parseAccountDeletionAccepted(payload)).toThrow(ApiTransportError);
  });

  it.each([
    { ...pending, extra: true },
    { ...pending, status: 'completed', completed_at: null, reason_code: null },
    { ...pending, status: 'action_required', reason_code: null },
    { ...pending, status: 'completed', completed_at: '2026-08-12T01:00:00Z' },
    { ...pending, status: 'completed', completed_at: '2026-08-11T23:59:59Z', reason_code: null },
    { ...pending, support_url: 'http://support.invalid' },
  ])('rejects malformed status projections', (payload) => {
    expect(() => parseAccountDeletionStatus(payload)).toThrow(ApiTransportError);
  });

  it('stores no secrets in the route and reuses the exact credential', async () => {
    const client = vi.fn(async (path: string) => (
      path === '/api/me/deletion-requests' ? accepted : pending
    )) as unknown as ApiClient;
    const service = createAccountDeletionService(client);

    await expect(service.request(credential)).resolves.toMatchObject({
      id: credential.requestId,
    });
    await expect(service.status(credential)).resolves.toMatchObject({
      id: credential.requestId,
      status: 'pending',
    });
    expect(client).toHaveBeenNthCalledWith(1, '/api/me/deletion-requests', {
      authenticated: true,
      json: {
        client_request_id: credential.requestId,
        confirmation: 'DELETE_MY_ACCOUNT',
        status_token: credential.statusToken,
      },
      method: 'POST',
    });
    expect(client).toHaveBeenNthCalledWith(
      2,
      `/api/account/deletion-requests/${credential.requestId}`,
      {
        authenticated: false,
        deletionStatusToken: credential.statusToken,
      },
    );
  });

  it('fails before transport for an invalid credential', async () => {
    const client = vi.fn() as unknown as ApiClient;
    const service = createAccountDeletionService(client);
    await expect(service.request({
      requestId: credential.requestId,
      statusToken: 'bad',
    })).rejects.toMatchObject({ failure: 'INVALID_RESPONSE' });
    expect(client).not.toHaveBeenCalled();
  });
});
