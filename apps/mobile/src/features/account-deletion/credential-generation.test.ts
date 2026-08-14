import { describe, expect, it } from 'vitest';

import { generateAccountDeletionCredential } from './credential-generation';

describe('account deletion credential generation', () => {
  it('uses 32 random bytes and a UUIDv4 without logging or hashing locally', async () => {
    let requestedLength = 0;
    await expect(generateAccountDeletionCredential({
      randomUuid: () => '11111111-1111-4111-8111-111111111111',
      randomBytes: async (length) => {
        requestedLength = length;
        return Uint8Array.from({ length }, (_, index) => index);
      },
    }, () => 123)).resolves.toEqual({
      requestId: '11111111-1111-4111-8111-111111111111',
      statusToken: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      createdAt: 123,
    });
    expect(requestedLength).toBe(32);
  });

  it.each([
    { uuid: 'invalid', length: 32 },
    { uuid: '11111111-1111-4111-8111-111111111111', length: 31 },
  ])('fails closed for invalid crypto output', async ({ uuid, length }) => {
    await expect(generateAccountDeletionCredential({
      randomUuid: () => uuid,
      randomBytes: async () => new Uint8Array(length),
    }, Date.now)).rejects.toThrow('ACCOUNT_DELETION_CREDENTIAL_GENERATION_FAILED');
  });
});
