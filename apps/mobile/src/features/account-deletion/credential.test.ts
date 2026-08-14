import { describe, expect, it, vi } from 'vitest';

import {
  createAccountDeletionCredentialStore,
  type AccountDeletionCredentialBackend,
} from './credential';

const value = {
  requestId: '11111111-1111-4111-8111-111111111111',
  statusToken: 'A'.repeat(43),
  createdAt: 1_723_420_800_000,
};

function backend(initial: string | null = null) {
  let current = initial;
  const result: AccountDeletionCredentialBackend = {
    getItem: vi.fn(async () => current),
    setItem: vi.fn(async (next) => { current = next; }),
    removeItem: vi.fn(async () => { current = null; }),
  };
  return result;
}

describe('account deletion credential store', () => {
  it('round-trips the request ID and status token exactly', async () => {
    const store = createAccountDeletionCredentialStore(backend());
    await store.save(value);
    await expect(store.load()).resolves.toEqual(value);
  });

  it('deletes malformed or extra-field records rather than exposing them', async () => {
    for (const raw of [
      '{',
      JSON.stringify({ ...value, statusToken: 'bad' }),
      JSON.stringify({ ...value, extra: true }),
    ]) {
      const storage = backend(raw);
      const store = createAccountDeletionCredentialStore(storage);
      await expect(store.load()).resolves.toBeNull();
      expect(storage.removeItem).toHaveBeenCalledOnce();
    }
  });

  it('clears only the expected pending request', async () => {
    const storage = backend();
    const store = createAccountDeletionCredentialStore(storage);
    await store.save(value);
    await store.clear('22222222-2222-4222-8222-222222222222');
    await expect(store.load()).resolves.toEqual(value);
    await store.clear(value.requestId);
    await expect(store.load()).resolves.toBeNull();
  });

  it('rejects invalid credentials before writing', async () => {
    const storage = backend();
    const store = createAccountDeletionCredentialStore(storage);
    await expect(store.save({ ...value, requestId: 'invalid' }))
      .rejects.toThrow('ACCOUNT_DELETION_CREDENTIAL_INVALID');
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});
