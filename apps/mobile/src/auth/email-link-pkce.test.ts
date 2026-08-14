import { describe, expect, it, vi } from 'vitest';

import { createEmailLinkPkce, toBase64Url } from './email-link-pkce';

describe('email-link PKCE', () => {
  it('creates a UUID v4 flow and a 43-character verifier/challenge', async () => {
    const sha256Base64 = vi.fn(async () => `${'A'.repeat(43)}=`);
    const result = await createEmailLinkPkce({
      randomUUID: () => '11111111-1111-4111-8111-111111111111',
      getRandomBytes: async () => Uint8Array.from(
        Array.from({ length: 43 }, (_, index) => index),
      ),
      sha256Base64,
    });

    expect(result.flowId).toBe('11111111-1111-4111-8111-111111111111');
    expect(result.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.challenge).toBe('A'.repeat(43));
    expect(sha256Base64).toHaveBeenCalledWith(result.verifier);
  });

  it('converts padded standard base64 to unpadded base64url', () => {
    expect(toBase64Url('ab+c/de==')).toBe('ab-c_de');
  });

  it('fails closed when native entropy or digest output is malformed', async () => {
    await expect(createEmailLinkPkce({
      randomUUID: () => 'not-a-uuid',
      getRandomBytes: async () => new Uint8Array(43),
      sha256Base64: async () => `${'A'.repeat(43)}=`,
    })).rejects.toThrow('EMAIL_LINK_CRYPTO_FAILED');

    await expect(createEmailLinkPkce({
      randomUUID: () => '11111111-1111-4111-8111-111111111111',
      getRandomBytes: async () => new Uint8Array(42),
      sha256Base64: async () => `${'A'.repeat(43)}=`,
    })).rejects.toThrow('EMAIL_LINK_CRYPTO_FAILED');
  });
});
