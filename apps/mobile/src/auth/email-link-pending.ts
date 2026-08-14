import type { AsyncKeyValueStorage } from './chunked-storage';

const STORAGE_KEY = 'danyeodam.email-link.pending.v1';
const MAX_PENDING_AGE_MS = 65 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type PendingEmailLink = {
  flowId: string;
  verifier: string;
  authUserId: string;
  createdAt: number;
};

export type PendingEmailLinkStore = {
  save(value: PendingEmailLink): Promise<void>;
  consume(flowId: string): Promise<PendingEmailLink | null>;
  clear(flowId?: string): Promise<void>;
};

function parsePending(raw: string | null): PendingEmailLink | null {
  if (raw === null || raw.length > 1_024) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<PendingEmailLink>;
    if (
      typeof value.flowId !== 'string'
      || !UUID_V4_PATTERN.test(value.flowId)
      || typeof value.verifier !== 'string'
      || !VERIFIER_PATTERN.test(value.verifier)
      || typeof value.authUserId !== 'string'
      || !UUID_PATTERN.test(value.authUserId)
      || typeof value.createdAt !== 'number'
      || !Number.isSafeInteger(value.createdAt)
    ) {
      return null;
    }
    return value as PendingEmailLink;
  } catch {
    return null;
  }
}

function isFresh(value: PendingEmailLink, now: number): boolean {
  return value.createdAt <= now + MAX_CLOCK_SKEW_MS
    && now - value.createdAt <= MAX_PENDING_AGE_MS;
}

export function createPendingEmailLinkStore(
  storage: AsyncKeyValueStorage,
  now: () => number = Date.now,
): PendingEmailLinkStore {
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
    async save(value) {
      if (
        !UUID_V4_PATTERN.test(value.flowId)
        || !VERIFIER_PATTERN.test(value.verifier)
        || !UUID_PATTERN.test(value.authUserId)
        || !Number.isSafeInteger(value.createdAt)
      ) {
        throw new Error('EMAIL_LINK_PENDING_INVALID');
      }
      await serialize(() => storage.setItem(STORAGE_KEY, JSON.stringify(value)));
    },

    consume(flowId) {
      return serialize(async () => {
        const raw = await storage.getItem(STORAGE_KEY);
        const pending = parsePending(raw);
        if (pending === null || !isFresh(pending, now())) {
          if (raw !== null) {
            await storage.removeItem(STORAGE_KEY);
          }
          return null;
        }
        if (pending.flowId !== flowId) {
          return null;
        }
        await storage.removeItem(STORAGE_KEY);
        return pending;
      });
    },

    clear(flowId) {
      return serialize(async () => {
        if (flowId === undefined) {
          await storage.removeItem(STORAGE_KEY);
          return;
        }
        const pending = parsePending(await storage.getItem(STORAGE_KEY));
        if (pending?.flowId === flowId) {
          await storage.removeItem(STORAGE_KEY);
        }
      });
    },
  };
}
