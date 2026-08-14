import type { ApiClient } from './client';
import {
  expectArray,
  expectBoolean,
  expectEnum,
  expectIsoDate,
  expectIsoDateTime,
  expectLocalizedText,
  expectNonnegativeInteger,
  expectRecord,
  expectString,
  expectUuid,
  invalidPayload,
  resolveApiAssetUrl,
  type LocalizedText,
} from './payload';

import type { SupportedLocale } from '@/i18n/locales';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RESOURCE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const PAGE_SIZE = 50;
const SEALED_KEYS = new Set(['id', 'status', 'issued_at', 'date_kst']);
const OPENED_KEYS = new Set([
  'id',
  'status',
  'issued_at',
  'date_kst',
  'opened_at',
  'card',
]);
const CARD_KEYS = new Set(['id', 'rarity', 'title', 'image_url', 'color_hex']);
const LIST_KEYS = new Set(['items', 'page', 'sealed_count']);
const PAGE_KEYS = new Set(['next_cursor', 'has_more']);
const DETAIL_KEYS = new Set(['bonus_pack']);

export type CardRarity = 'common' | 'special';

export type BonusCard = Readonly<{
  id: string;
  rarity: CardRarity;
  title: LocalizedText;
  imageUrl: string;
  colorHex: string;
}>;

export type SealedBonusPack = Readonly<{
  id: string;
  status: 'sealed';
  issuedAt: string;
  dateKst: string;
}>;

export type OpenedBonusPack = Readonly<{
  id: string;
  status: 'opened';
  issuedAt: string;
  dateKst: string;
  openedAt: string;
  card: BonusCard;
}>;

export type BonusPack = SealedBonusPack | OpenedBonusPack;

export type BonusPackPage = Readonly<{
  items: readonly BonusPack[];
  nextCursor: string | null;
  hasMore: boolean;
  sealedCount: number;
}>;

export class BonusPackRequestError extends Error {
  constructor() {
    super('Bonus pack request input is invalid.');
    this.name = 'BonusPackRequestError';
  }
}

function expectNullableCursor(value: unknown): string | null {
  return value === null
    ? null
    : expectString(value, {
        minimumLength: 3,
        maximumLength: 1_024,
        pattern: CURSOR_PATTERN,
      });
}

export function parseBonusCard(value: unknown, apiBaseUrl: string): BonusCard {
  const card = expectRecord(value);
  if (Object.keys(card).some((key) => !CARD_KEYS.has(key))) {
    return invalidPayload();
  }
  const id = expectUuid(card.id);
  const rarity = expectEnum(card.rarity, ['common', 'special'] as const);
  const imagePath = expectString(card.image_url, {
    minimumLength: 1,
    maximumLength: 128,
  });
  const expectedImagePath = rarity === 'special'
    ? `/api/me/special-card-assets/${id}`
    : `/api/card-assets/${id}`;
  if (imagePath !== expectedImagePath) {
    return invalidPayload();
  }
  return {
    id,
    rarity,
    title: expectLocalizedText(card.title),
    imageUrl: resolveApiAssetUrl(apiBaseUrl, imagePath),
    colorHex: expectString(card.color_hex, {
      minimumLength: 7,
      maximumLength: 7,
      pattern: COLOR_PATTERN,
    }),
  };
}

export function parseSealedBonusPack(value: unknown): SealedBonusPack {
  const pack = expectRecord(value);
  if (
    pack.status !== 'sealed'
    || Object.keys(pack).some((key) => !SEALED_KEYS.has(key))
  ) {
    return invalidPayload();
  }
  return {
    id: expectUuid(pack.id),
    status: 'sealed',
    issuedAt: expectIsoDateTime(pack.issued_at),
    dateKst: expectIsoDate(pack.date_kst),
  };
}

export function parseBonusPack(value: unknown, apiBaseUrl: string): BonusPack {
  const pack = expectRecord(value);
  if (pack.status === 'sealed') {
    return parseSealedBonusPack(pack);
  }
  if (pack.status !== 'opened') {
    return invalidPayload();
  }
  if (Object.keys(pack).some((key) => !OPENED_KEYS.has(key))) {
    return invalidPayload();
  }
  const issuedAt = expectIsoDateTime(pack.issued_at);
  const openedAt = expectIsoDateTime(pack.opened_at);
  if (Date.parse(openedAt) < Date.parse(issuedAt)) {
    return invalidPayload();
  }
  return {
    id: expectUuid(pack.id),
    status: 'opened',
    issuedAt,
    dateKst: expectIsoDate(pack.date_kst),
    openedAt,
    card: parseBonusCard(pack.card, apiBaseUrl),
  };
}

export function parseBonusPackPage(
  value: unknown,
  apiBaseUrl: string,
): BonusPackPage {
  const record = expectRecord(value);
  if (Object.keys(record).some((key) => !LIST_KEYS.has(key))) {
    return invalidPayload();
  }
  const page = expectRecord(record.page);
  if (Object.keys(page).some((key) => !PAGE_KEYS.has(key))) {
    return invalidPayload();
  }
  const items = expectArray(record.items, PAGE_SIZE).map((item) => (
    parseBonusPack(item, apiBaseUrl)
  ));
  if (new Set(items.map(({ id }) => id)).size !== items.length) {
    return invalidPayload();
  }
  const nextCursor = expectNullableCursor(page.next_cursor);
  const hasMore = expectBoolean(page.has_more);
  const sealedCount = expectNonnegativeInteger(record.sealed_count);
  if (hasMore !== (nextCursor !== null)) {
    return invalidPayload();
  }
  if (sealedCount < items.filter(({ status }) => status === 'sealed').length) {
    return invalidPayload();
  }
  return { items, nextCursor, hasMore, sealedCount };
}

export function mergeBonusPacks(
  current: readonly BonusPack[],
  incoming: readonly BonusPack[],
): readonly BonusPack[] {
  const known = new Set(current.map(({ id }) => id));
  return [...current, ...incoming.filter((pack) => {
    if (known.has(pack.id)) {
      return false;
    }
    known.add(pack.id);
    return true;
  })];
}

function validatePackId(packId: string): void {
  if (!RESOURCE_UUID_PATTERN.test(packId)) {
    throw new BonusPackRequestError();
  }
}

export function createBonusPackService(dependencies: {
  client: ApiClient;
  apiBaseUrl: string;
}) {
  return {
    async page(input: {
      locale: SupportedLocale;
      cursor?: string;
      signal?: AbortSignal;
    }): Promise<BonusPackPage> {
      const path = input.cursor === undefined
        ? `/api/me/bonus-packs?limit=${PAGE_SIZE}`
        : `/api/me/bonus-packs?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(input.cursor)}`;
      const result = await dependencies.client<unknown>(path, {
        locale: input.locale,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      return parseBonusPackPage(result, dependencies.apiBaseUrl);
    },

    async detail(input: {
      packId: string;
      locale: SupportedLocale;
      signal?: AbortSignal;
    }): Promise<BonusPack> {
      validatePackId(input.packId);
      const result = await dependencies.client<unknown>(
        `/api/me/bonus-packs/${input.packId}`,
        {
          locale: input.locale,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
      );
      const record = expectRecord(result);
      if (Object.keys(record).some((key) => !DETAIL_KEYS.has(key))) {
        return invalidPayload();
      }
      const pack = parseBonusPack(record.bonus_pack, dependencies.apiBaseUrl);
      return pack.id === input.packId ? pack : invalidPayload();
    },

    async open(input: {
      packId: string;
      clientRequestId: string;
      locale: SupportedLocale;
      signal?: AbortSignal;
    }): Promise<OpenedBonusPack> {
      validatePackId(input.packId);
      if (!UUID_V4_PATTERN.test(input.clientRequestId)) {
        throw new BonusPackRequestError();
      }
      const result = await dependencies.client<unknown>(
        `/api/me/bonus-packs/${input.packId}/open`,
        {
          method: 'POST',
          locale: input.locale,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          json: { client_request_id: input.clientRequestId },
        },
      );
      const record = expectRecord(result);
      if (Object.keys(record).some((key) => !DETAIL_KEYS.has(key))) {
        return invalidPayload();
      }
      const pack = parseBonusPack(record.bonus_pack, dependencies.apiBaseUrl);
      return pack.id === input.packId && pack.status === 'opened'
        ? pack
        : invalidPayload();
    },
  };
}
