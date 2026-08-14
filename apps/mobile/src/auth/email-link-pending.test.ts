import { describe, expect, it } from 'vitest';

import type { AsyncKeyValueStorage } from './chunked-storage';
import { createPendingEmailLinkStore } from './email-link-pending';

const FLOW_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_FLOW_ID = '22222222-2222-4222-8222-222222222222';
const AUTH_USER_ID = '33333333-3333-4333-8333-333333333333';

function memoryStorage(): AsyncKeyValueStorage {
  const values = new Map<string, string>();
  return {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
}

function pending(createdAt = 1_000) {
  return {
    flowId: FLOW_ID,
    verifier: 'v'.repeat(43),
    authUserId: AUTH_USER_ID,
    createdAt,
  };
}

describe('pending email-link storage', () => {
  it('consumes a matching verifier exactly once', async () => {
    const store = createPendingEmailLinkStore(memoryStorage(), () => 2_000);
    await store.save(pending());
    await expect(store.consume(FLOW_ID)).resolves.toEqual(pending());
    await expect(store.consume(FLOW_ID)).resolves.toBeNull();
  });

  it('does not let a mismatched deep link erase the valid pending flow', async () => {
    const store = createPendingEmailLinkStore(memoryStorage(), () => 2_000);
    await store.save(pending());
    await expect(store.consume(OTHER_FLOW_ID)).resolves.toBeNull();
    await expect(store.consume(FLOW_ID)).resolves.toEqual(pending());
  });

  it('allows only one winner for concurrent callback handling', async () => {
    const store = createPendingEmailLinkStore(memoryStorage(), () => 2_000);
    await store.save(pending());
    const results = await Promise.all([store.consume(FLOW_ID), store.consume(FLOW_ID)]);
    expect(results.filter((value) => value !== null)).toHaveLength(1);
  });

  it('removes expired and corrupt entries', async () => {
    const storage = memoryStorage();
    const store = createPendingEmailLinkStore(storage, () => 65 * 60 * 1_000 + 1_001);
    await store.save(pending());
    await expect(store.consume(FLOW_ID)).resolves.toBeNull();
    await expect(store.consume(FLOW_ID)).resolves.toBeNull();
  });
});
