export const ACCOUNT_DELETION_CREDENTIAL_KEY =
  'danyeodam.account-deletion.credential.v1';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STATUS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_SERIALIZED_LENGTH = 512;

export type StoredAccountDeletionCredential = Readonly<{
  requestId: string;
  statusToken: string;
  createdAt: number;
}>;

export type AccountDeletionCredentialBackend = {
  getItem(): Promise<string | null>;
  setItem(value: string): Promise<void>;
  removeItem(): Promise<void>;
};

export type AccountDeletionCredentialStore = {
  load(): Promise<StoredAccountDeletionCredential | null>;
  save(value: StoredAccountDeletionCredential): Promise<void>;
  clear(expectedRequestId?: string): Promise<void>;
};

function valid(value: StoredAccountDeletionCredential): boolean {
  return UUID_V4_PATTERN.test(value.requestId)
    && STATUS_TOKEN_PATTERN.test(value.statusToken)
    && Number.isSafeInteger(value.createdAt)
    && value.createdAt >= 0;
}

function parse(raw: string | null): StoredAccountDeletionCredential | null {
  if (raw === null || raw.length > MAX_SERIALIZED_LENGTH) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredAccountDeletionCredential>;
    return typeof value.requestId === 'string'
      && typeof value.statusToken === 'string'
      && typeof value.createdAt === 'number'
      && Object.keys(value).length === 3
      && valid(value as StoredAccountDeletionCredential)
      ? value as StoredAccountDeletionCredential
      : null;
  } catch {
    return null;
  }
}

export function createAccountDeletionCredentialStore(
  backend: AccountDeletionCredentialBackend,
): AccountDeletionCredentialStore {
  let operation = Promise.resolve();
  const serialize = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = operation;
    let release = () => {};
    operation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };

  return {
    load() {
      return serialize(async () => {
        const raw = await backend.getItem();
        const value = parse(raw);
        if (raw !== null && value === null) await backend.removeItem();
        return value;
      });
    },
    save(value) {
      return serialize(async () => {
        if (!valid(value)) throw new Error('ACCOUNT_DELETION_CREDENTIAL_INVALID');
        await backend.setItem(JSON.stringify(value));
      });
    },
    clear(expectedRequestId) {
      return serialize(async () => {
        if (expectedRequestId === undefined) {
          await backend.removeItem();
          return;
        }
        const current = parse(await backend.getItem());
        if (current?.requestId === expectedRequestId) await backend.removeItem();
      });
    },
  };
}
