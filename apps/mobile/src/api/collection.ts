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

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const SHARE_SLUG_PATTERN = /^[A-Za-z0-9]{22,128}$/u;
const REASON_PATTERN = /^[A-Z0-9_]{1,64}$/u;
const PAGE_SIZE = 20;

export type AcquisitionType = 'field' | 'retro' | 'gift';
export type ShareStatus =
  | 'private'
  | 'pending'
  | 'active'
  | 'rejected'
  | 'taken_down';

export type CollectionItem = {
  acquisition: {
    id: string;
    spotId: string;
    cardId: string;
    type: AcquisitionType;
    acquiredAt: string;
    dateKst: string;
  };
  spot: { slug: string; name: LocalizedText };
  card: { title: LocalizedText; imageUrl: string; colorHex: string };
  personalCard: null | {
    id: string;
    caption: string;
    photoPath: string;
    createdAt: string;
    share: {
      status: ShareStatus;
      slug: string | null;
      url: string | null;
      reasonCode: string | null;
    };
  };
};

export type CollectionStats = {
  totalAcquisitions: number;
  spotsVisited: number;
  personalCards: number;
};

export type CollectionPage = {
  items: readonly CollectionItem[];
  nextCursor: string | null;
  hasMore: boolean;
  stats: CollectionStats;
};

function expectNullableString(
  value: unknown,
  options: Parameters<typeof expectString>[1],
): string | null {
  return value === null ? null : expectString(value, options);
}

function expectShareUrl(value: unknown, slug: string | null): string | null {
  if (value === null) {
    return null;
  }
  const candidate = expectString(value, { minimumLength: 1, maximumLength: 2_048 });
  try {
    const parsed = new URL(candidate);
    const localDevelopment = parsed.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
    if (
      (parsed.protocol !== 'https:' && !localDevelopment)
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.search !== ''
      || slug === null
      || parsed.pathname !== '/share'
      || parsed.hash !== `#${slug}`
    ) {
      return invalidPayload();
    }
    return parsed.toString();
  } catch {
    return invalidPayload();
  }
}

function parsePersonalCard(value: unknown): NonNullable<CollectionItem['personalCard']> {
  const record = expectRecord(value);
  const id = expectUuid(record.id);
  const shareRecord = expectRecord(record.share);
  const shareStatus = expectEnum(shareRecord.status, [
    'private',
    'pending',
    'active',
    'rejected',
    'taken_down',
  ] as const);
  const shareSlug = expectNullableString(shareRecord.slug, {
    minimumLength: 22,
    maximumLength: 128,
    pattern: SHARE_SLUG_PATTERN,
  });
  const shareUrl = expectShareUrl(shareRecord.url, shareSlug);
  if ((shareStatus === 'active') !== (shareUrl !== null)) {
    return invalidPayload();
  }
  const photoPath = expectString(record.photo_url, {
    minimumLength: 1,
    maximumLength: 128,
  });
  if (photoPath !== `/api/personal-cards/${id}/photo`) {
    return invalidPayload();
  }
  return {
    id,
    caption: expectString(record.caption, { maximumLength: 60 }),
    photoPath,
    createdAt: expectIsoDateTime(record.created_at),
    share: {
      status: shareStatus,
      slug: shareSlug,
      url: shareUrl,
      reasonCode: expectNullableString(shareRecord.reason_code, {
        minimumLength: 1,
        maximumLength: 64,
        pattern: REASON_PATTERN,
      }),
    },
  };
}

function parseCollectionItem(value: unknown, apiBaseUrl: string): CollectionItem {
  const record = expectRecord(value);
  const acquisition = expectRecord(record.acquisition);
  const spot = expectRecord(record.spot);
  const card = expectRecord(record.card);
  const cardId = expectUuid(acquisition.card_id);
  const imagePath = expectString(card.image_url, {
    minimumLength: 1,
    maximumLength: 128,
  });
  if (imagePath !== `/api/card-assets/${cardId}`) {
    return invalidPayload();
  }
  return {
    acquisition: {
      id: expectUuid(acquisition.id),
      spotId: expectUuid(acquisition.spot_id),
      cardId,
      type: expectEnum(acquisition.type, ['field', 'retro', 'gift'] as const),
      acquiredAt: expectIsoDateTime(acquisition.acquired_at),
      dateKst: expectIsoDate(acquisition.date_kst),
    },
    spot: {
      slug: expectString(spot.slug, {
        minimumLength: 1,
        maximumLength: 128,
        pattern: SLUG_PATTERN,
      }),
      name: expectLocalizedText(spot.name),
    },
    card: {
      title: expectLocalizedText(card.title),
      imageUrl: resolveApiAssetUrl(apiBaseUrl, imagePath),
      colorHex: expectString(card.color_hex, {
        minimumLength: 7,
        maximumLength: 7,
        pattern: COLOR_PATTERN,
      }),
    },
    personalCard: record.personal_card === null
      ? null
      : parsePersonalCard(record.personal_card),
  };
}

export function parseCollectionPage(value: unknown, apiBaseUrl: string): CollectionPage {
  const record = expectRecord(value);
  const page = expectRecord(record.page);
  const stats = expectRecord(record.stats);
  const items = expectArray(record.items, 100).map((item) => (
    parseCollectionItem(item, apiBaseUrl)
  ));
  if (new Set(items.map(({ acquisition }) => acquisition.id)).size !== items.length) {
    return invalidPayload();
  }
  const nextCursor = expectNullableString(page.next_cursor, {
    minimumLength: 3,
    maximumLength: 1_024,
    pattern: CURSOR_PATTERN,
  });
  const hasMore = expectBoolean(page.has_more);
  if (hasMore !== (nextCursor !== null)) {
    return invalidPayload();
  }
  const parsedStats = {
    totalAcquisitions: expectNonnegativeInteger(stats.total_acquisitions),
    spotsVisited: expectNonnegativeInteger(stats.spots_visited),
    personalCards: expectNonnegativeInteger(stats.personal_cards),
  };
  if (
    parsedStats.totalAcquisitions < items.length
    || parsedStats.spotsVisited > parsedStats.totalAcquisitions
    || parsedStats.personalCards > parsedStats.totalAcquisitions
  ) {
    return invalidPayload();
  }
  return { items, nextCursor, hasMore, stats: parsedStats };
}

export function mergeCollectionItems(
  current: readonly CollectionItem[],
  incoming: readonly CollectionItem[],
): readonly CollectionItem[] {
  const known = new Set(current.map(({ acquisition }) => acquisition.id));
  return [...current, ...incoming.filter(({ acquisition }) => {
    if (known.has(acquisition.id)) {
      return false;
    }
    known.add(acquisition.id);
    return true;
  })];
}

export function createCollectionService(dependencies: {
  client: ApiClient;
  apiBaseUrl: string;
}) {
  return {
    async page(input: {
      locale: SupportedLocale;
      cursor?: string;
      signal?: AbortSignal;
    }): Promise<CollectionPage> {
      const path = input.cursor === undefined
        ? `/api/me/collection?limit=${PAGE_SIZE}`
        : `/api/me/collection?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(input.cursor)}`;
      const result = await dependencies.client<unknown>(path, {
        locale: input.locale,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      return parseCollectionPage(result, dependencies.apiBaseUrl);
    },
  };
}
