import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from './client';
import { ApiTransportError } from './client';
import { createBlocksService, parseUserBlocksPage } from './blocks';

const blockId = '11111111-1111-4111-8111-111111111111';
const actionId = '22222222-2222-4222-8222-222222222222';
const shareSecret = 'AbCdEfGhIjKlMnOpQrStUv';

function client(response: unknown = undefined): ApiClient {
  const request = vi.fn(async () => response) as unknown as ApiClient;
  request.cacheAware = vi.fn();
  return request;
}

describe('user-block API', () => {
  it('strictly parses only opaque IDs, timestamps, and a consistent page', () => {
    expect(parseUserBlocksPage({
      blocks: [{ id: blockId, created_at: '2026-08-12T01:02:03.000Z' }],
      page: { next_cursor: null, has_more: false },
    })).toEqual({
      items: [{ id: blockId, createdAt: '2026-08-12T01:02:03.000Z' }],
      nextCursor: null,
    });

    for (const payload of [
      { blocks: [{ id: blockId, created_at: '2026-08-12T01:02:03.000Z', owner_id: actionId }], page: { next_cursor: null, has_more: false } },
      { blocks: [{ id: blockId, created_at: 'bad' }], page: { next_cursor: null, has_more: false } },
      { blocks: [{ id: blockId, created_at: '2026-08-12T01:02:03.000Z' }], page: { next_cursor: 'cursor.sig', has_more: false } },
    ]) {
      expect(() => parseUserBlocksPage(payload)).toThrow(ApiTransportError);
    }
  });

  it('uses exact bearer routes and preserves caller-owned mutation IDs', async () => {
    const request = client({ blocks: [], page: { next_cursor: null, has_more: false } });
    const service = createBlocksService(request);

    await service.blockShareOwner({ shareSecret, clientActionId: actionId });
    expect(request).toHaveBeenNthCalledWith(1, '/api/public-share/block', {
      method: 'POST',
      json: { share_secret: shareSecret, client_action_id: actionId },
    });

    await service.list({ limit: 50, cursor: 'cursor.signature' });
    expect(request).toHaveBeenNthCalledWith(
      2,
      '/api/me/blocks?limit=50&cursor=cursor.signature',
      {},
    );

    await service.unblock({ blockId, clientActionId: actionId });
    expect(request).toHaveBeenNthCalledWith(3, `/api/me/blocks/${blockId}`, {
      method: 'DELETE',
      json: { client_action_id: actionId },
    });
  });

  it('rejects invalid secrets, IDs, limits, and cursors before transport', async () => {
    const request = client();
    const service = createBlocksService(request);
    await expect(service.blockShareOwner({ shareSecret: 'short', clientActionId: actionId }))
      .rejects.toBeInstanceOf(ApiTransportError);
    await expect(service.unblock({ blockId: 'bad', clientActionId: actionId }))
      .rejects.toBeInstanceOf(ApiTransportError);
    await expect(service.list({ limit: 101 })).rejects.toBeInstanceOf(ApiTransportError);
    await expect(service.list({ cursor: '' })).rejects.toBeInstanceOf(ApiTransportError);
    expect(request).not.toHaveBeenCalled();
  });
});
