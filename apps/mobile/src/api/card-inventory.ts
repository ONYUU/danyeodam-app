import type { ApiClient } from './client';
import { parseBonusCard, type BonusCard } from './bonus-packs';
import {
  expectArray,
  expectBoolean,
  expectIsoDateTime,
  expectNonnegativeInteger,
  expectRecord,
  expectString,
  invalidPayload,
} from './payload';

import type { SupportedLocale } from '@/i18n/locales';

const CURSOR_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const PAGE_SIZE = 50;
const LIST_KEYS = new Set(['items', 'page']);
const PAGE_KEYS = new Set(['next_cursor', 'has_more']);
const ITEM_KEYS = new Set([
  'card',
  'quantity',
  'first_acquired_at',
  'last_acquired_at',
]);

export type InventoryItem = Readonly<{
  card: BonusCard;
  quantity: number;
  firstAcquiredAt: string;
  lastAcquiredAt: string;
}>;

export type InventoryPage = Readonly<{
  items: readonly InventoryItem[];
  nextCursor: string | null;
  hasMore: boolean;
}>;

function parseInventoryItem(value: unknown, apiBaseUrl: string): InventoryItem {
  const record = expectRecord(value);
  if (Object.keys(record).some((key) => !ITEM_KEYS.has(key))) {
    return invalidPayload();
  }
  const card = parseBonusCard(record.card, apiBaseUrl);
  const quantity = expectNonnegativeInteger(record.quantity);
  if (quantity < 1) {
    return invalidPayload();
  }
  const firstAcquiredAt = expectIsoDateTime(record.first_acquired_at);
  const lastAcquiredAt = expectIsoDateTime(record.last_acquired_at);
  if (Date.parse(lastAcquiredAt) < Date.parse(firstAcquiredAt)) {
    return invalidPayload();
  }
  return {
    card: {
      ...card,
    },
    quantity,
    firstAcquiredAt,
    lastAcquiredAt,
  };
}

export function parseInventoryPage(
  value: unknown,
  apiBaseUrl: string,
): InventoryPage {
  const record = expectRecord(value);
  if (Object.keys(record).some((key) => !LIST_KEYS.has(key))) {
    return invalidPayload();
  }
  const page = expectRecord(record.page);
  if (Object.keys(page).some((key) => !PAGE_KEYS.has(key))) {
    return invalidPayload();
  }
  const items = expectArray(record.items, PAGE_SIZE).map((item) => (
    parseInventoryItem(item, apiBaseUrl)
  ));
  if (new Set(items.map(({ card }) => card.id)).size !== items.length) {
    return invalidPayload();
  }
  const nextCursor = page.next_cursor === null
    ? null
    : expectString(page.next_cursor, {
        minimumLength: 3,
        maximumLength: 1_024,
        pattern: CURSOR_PATTERN,
      });
  const hasMore = expectBoolean(page.has_more);
  if (hasMore !== (nextCursor !== null)) {
    return invalidPayload();
  }
  return { items, nextCursor, hasMore };
}

export function mergeInventoryItems(
  current: readonly InventoryItem[],
  incoming: readonly InventoryItem[],
): readonly InventoryItem[] {
  const known = new Set(current.map(({ card }) => card.id));
  return [...current, ...incoming.filter(({ card }) => {
    if (known.has(card.id)) {
      return false;
    }
    known.add(card.id);
    return true;
  })];
}

export function createCardInventoryService(dependencies: {
  client: ApiClient;
  apiBaseUrl: string;
}) {
  return async function page(input: {
    locale: SupportedLocale;
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<InventoryPage> {
    const path = input.cursor === undefined
      ? `/api/me/card-inventory?limit=${PAGE_SIZE}`
      : `/api/me/card-inventory?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(input.cursor)}`;
    const result = await dependencies.client<unknown>(path, {
      locale: input.locale,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return parseInventoryPage(result, dependencies.apiBaseUrl);
  };
}
