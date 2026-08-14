const PKCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PKCE_VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type EmailLinkPkce = {
  flowId: string;
  verifier: string;
  challenge: string;
};

export type PkceCryptoGateway = {
  randomUUID(): string;
  getRandomBytes(length: number): Promise<Uint8Array>;
  sha256Base64(value: string): Promise<string>;
};

export function toBase64Url(value: string): string {
  return value.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export async function createEmailLinkPkce(
  crypto: PkceCryptoGateway,
): Promise<EmailLinkPkce> {
  const flowId = crypto.randomUUID().toLowerCase();
  if (!UUID_V4_PATTERN.test(flowId)) {
    throw new Error('EMAIL_LINK_CRYPTO_FAILED');
  }

  const random = await crypto.getRandomBytes(43);
  if (random.byteLength !== 43) {
    throw new Error('EMAIL_LINK_CRYPTO_FAILED');
  }
  let verifier = '';
  for (const byte of random) {
    verifier += PKCE_ALPHABET[byte & 63];
  }

  const challenge = toBase64Url(await crypto.sha256Base64(verifier));
  if (!PKCE_VALUE_PATTERN.test(verifier) || !PKCE_VALUE_PATTERN.test(challenge)) {
    throw new Error('EMAIL_LINK_CRYPTO_FAILED');
  }

  return { flowId, verifier, challenge };
}
