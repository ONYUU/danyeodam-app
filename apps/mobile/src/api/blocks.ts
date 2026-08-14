import type { ApiClient } from './client';
import {
  expectArray,
  expectBoolean,
  expectIsoDateTime,
  expectRecord,
  expectString,
  expectUuid,
  invalidPayload,
} from './payload';

const CURSOR_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const SHARE_SECRET_PATTERN = /^[A-Za-z0-9]{22,128}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_LIMIT = 50;
const MAXIMUM_LIMIT = 100;

export type UserBlock = {
  id: string;
  createdAt: string;
};

export type UserBlocksPage = {
  items: readonly UserBlock[];
  nextCursor: string | null;
};

function expectExactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = expectRecord(value);
  const actual = Object.keys(record);
  if (actual.length !== keys.length || !actual.every((key) => keys.includes(key))) {
    return invalidPayload();
  }
  return record;
}

function expectCursor(value: unknown): string | null {
  return value === null
    ? null
    : expectString(value, {
        minimumLength: 3,
        maximumLength: 1_024,
        pattern: CURSOR_PATTERN,
      });
}

function expectLimit(value: number): number {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAXIMUM_LIMIT
    ? value
    : invalidPayload();
}

export function parseUserBlocksPage(
  value: unknown,
  requestedLimit = DEFAULT_LIMIT,
): UserBlocksPage {
  const limit = expectLimit(requestedLimit);
  const record = expectExactRecord(value, ['blocks', 'page']);
  const items = expectArray(record.blocks, limit).map((item) => {
    const block = expectExactRecord(item, ['id', 'created_at']);
    return {
      id: expectUuid(block.id),
      createdAt: expectIsoDateTime(block.created_at),
    };
  });
  const page = expectExactRecord(record.page, ['next_cursor', 'has_more']);
  const nextCursor = expectCursor(page.next_cursor);
  const hasMore = expectBoolean(page.has_more);
  if (
    hasMore !== (nextCursor !== null)
    || (hasMore && items.length !== limit)
    || new Set(items.map(({ id }) => id)).size !== items.length
  ) {
    return invalidPayload();
  }
  return { items, nextCursor };
}

function expectUuidInput(value: string): string {
  return UUID_PATTERN.test(value) ? value : invalidPayload();
}

function expectShareSecret(value: string): string {
  return SHARE_SECRET_PATTERN.test(value) ? value : invalidPayload();
}

export function createBlocksService(client: ApiClient) {
  return {
    async blockShareOwner(input: {
      shareSecret: string;
      clientActionId: string;
      signal?: AbortSignal;
    }): Promise<void> {
      await client<void>('/api/public-share/block', {
        method: 'POST',
        json: {
          share_secret: expectShareSecret(input.shareSecret),
          client_action_id: expectUuidInput(input.clientActionId),
        },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    },

    async list(input: {
      limit?: number;
      cursor?: string;
      signal?: AbortSignal;
    } = {}): Promise<UserBlocksPage> {
      const limit = expectLimit(input.limit ?? DEFAULT_LIMIT);
      const cursor = input.cursor === undefined ? null : expectCursor(input.cursor);
      if (input.cursor !== undefined && cursor === null) {
        return invalidPayload();
      }
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor !== null) query.set('cursor', cursor);
      const payload = await client<unknown>(`/api/me/blocks?${query.toString()}`, {
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      return parseUserBlocksPage(payload, limit);
    },

    async unblock(input: {
      blockId: string;
      clientActionId: string;
      signal?: AbortSignal;
    }): Promise<void> {
      await client<void>(`/api/me/blocks/${expectUuidInput(input.blockId)}`, {
        method: 'DELETE',
        json: { client_action_id: expectUuidInput(input.clientActionId) },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    },
  };
}
