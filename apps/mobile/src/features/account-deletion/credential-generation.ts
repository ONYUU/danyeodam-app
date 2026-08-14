import type { StoredAccountDeletionCredential } from './credential';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type AccountDeletionCredentialCrypto = {
  randomUuid(): string;
  randomBytes(length: number): Promise<Uint8Array>;
};

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

export async function generateAccountDeletionCredential(
  crypto: AccountDeletionCredentialCrypto,
  now: () => number,
): Promise<StoredAccountDeletionCredential> {
  const requestId = crypto.randomUuid().toLowerCase();
  const random = await crypto.randomBytes(32);
  const createdAt = now();
  if (
    !UUID_V4_PATTERN.test(requestId)
    || random.length !== 32
    || !Number.isSafeInteger(createdAt)
    || createdAt < 0
  ) {
    throw new Error('ACCOUNT_DELETION_CREDENTIAL_GENERATION_FAILED');
  }
  const statusToken = base64Url(random);
  if (statusToken.length !== 43) {
    throw new Error('ACCOUNT_DELETION_CREDENTIAL_GENERATION_FAILED');
  }
  return { requestId, statusToken, createdAt };
}
