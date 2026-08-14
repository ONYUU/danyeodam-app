import { describe, expect, it, vi } from 'vitest';

import {
  ApiTransportError,
  createApiClient,
  type ApiClient,
} from './client';
import {
  createPersonalCardDeleteService,
  parsePersonalCardDeleteAccepted,
} from './personal-card-delete';

const personalCardId = '44444444-4444-4444-8444-444444444444';
const clientRequestId = '55555555-5555-4555-8555-555555555555';

function apiClient(
  implementation: (path: string, options?: unknown) => Promise<unknown>,
): ApiClient {
  const request = vi.fn(implementation) as unknown as ApiClient;
  request.cacheAware = vi.fn() as ApiClient['cacheAware'];
  return request;
}

describe('personal-card deletion API contract', () => {
  it('sends the exact UUID request body and accepts only the exact 202 payload', async () => {
    const client = apiClient(async () => ({ status: 'accepted' }));
    const service = createPersonalCardDeleteService(client);

    await expect(service.remove({
      personalCardId,
      clientRequestId,
    })).resolves.toBe('accepted');
    expect(client).toHaveBeenCalledWith(`/api/personal-cards/${personalCardId}`, {
      method: 'DELETE',
      expectedStatus: 202,
      json: { client_request_id: clientRequestId },
    });
  });

  it.each([200, 201])(
    'rejects HTTP %i even when the response body resembles an accepted deletion',
    async (status) => {
      const service = createPersonalCardDeleteService(createApiClient({
        apiBaseUrl: 'https://api.danyeodam.test',
        getAccessToken: async () => 'access-token',
        clearLocalSession: async () => undefined,
        fetch: async () => Response.json({ status: 'accepted' }, { status }),
      }));

      await expect(service.remove({
        personalCardId,
        clientRequestId,
      })).rejects.toMatchObject({ failure: 'INVALID_RESPONSE' });
    },
  );

  it('accepts the exact HTTP 202 and exact response body through the real transport', async () => {
    const service = createPersonalCardDeleteService(createApiClient({
      apiBaseUrl: 'https://api.danyeodam.test',
      getAccessToken: async () => 'access-token',
      clearLocalSession: async () => undefined,
      fetch: async () => Response.json({ status: 'accepted' }, { status: 202 }),
    }));

    await expect(service.remove({
      personalCardId,
      clientRequestId,
    })).resolves.toBe('accepted');
  });

  it('rejects malformed IDs before making a request', async () => {
    const client = apiClient(async () => ({ status: 'accepted' }));
    const service = createPersonalCardDeleteService(client);

    await expect(service.remove({
      personalCardId: '../different-path',
      clientRequestId,
    })).rejects.toBeInstanceOf(ApiTransportError);
    expect(client).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    {},
    { status: 'queued' },
    { status: 'accepted', deletion: { personal_card_id: personalCardId } },
  ])('rejects non-contract response %o', (payload) => {
    expect(() => parsePersonalCardDeleteAccepted(payload)).toThrow(ApiTransportError);
  });
});
