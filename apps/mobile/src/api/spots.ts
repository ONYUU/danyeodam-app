import type {
  ApiCacheAwareResult,
  ApiCacheRequestOptions,
} from './client';
import {
  expectArray,
  expectEnum,
  expectFiniteNumber,
  expectIsoDateTime,
  expectLocalizedText,
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

export type Spot = {
  id: string;
  slug: string;
  name: LocalizedText;
  region: { code: string; name: LocalizedText };
  status: 'open' | 'teaser';
  latitude: number;
  longitude: number;
  card: null | {
    id: string;
    title: LocalizedText;
    imageUrl: string;
    colorHex: string;
  };
};

export type SpotsSnapshot = {
  contentVersion: string;
  spots: readonly Spot[];
};

type CacheClient = {
  cacheAware<T>(
    path: string,
    options?: ApiCacheRequestOptions,
  ): Promise<ApiCacheAwareResult<T>>;
};

function parseCard(value: unknown, apiBaseUrl: string): NonNullable<Spot['card']> {
  const record = expectRecord(value);
  const id = expectUuid(record.id);
  const path = expectString(record.sketch_url, {
    minimumLength: 1,
    maximumLength: 128,
  });
  if (path !== `/api/card-assets/${id}`) {
    return invalidPayload();
  }
  return {
    id,
    title: expectLocalizedText(record.title),
    imageUrl: resolveApiAssetUrl(apiBaseUrl, path),
    colorHex: expectString(record.color_hex, {
      minimumLength: 7,
      maximumLength: 7,
      pattern: COLOR_PATTERN,
    }),
  };
}

function parseSpot(value: unknown, apiBaseUrl: string): Spot {
  const record = expectRecord(value);
  const region = expectRecord(record.region);
  const status = expectEnum(record.status, ['open', 'teaser'] as const);
  if ((status === 'teaser') !== (record.card === null)) {
    return invalidPayload();
  }
  return {
    id: expectUuid(record.id),
    slug: expectString(record.slug, {
      minimumLength: 1,
      maximumLength: 128,
      pattern: SLUG_PATTERN,
    }),
    name: expectLocalizedText(record.name),
    region: {
      code: expectString(region.code, {
        minimumLength: 1,
        maximumLength: 64,
        pattern: SLUG_PATTERN,
      }),
      name: expectLocalizedText(region.name),
    },
    status,
    latitude: expectFiniteNumber(record.latitude, -90, 90),
    longitude: expectFiniteNumber(record.longitude, -180, 180),
    card: record.card === null ? null : parseCard(record.card, apiBaseUrl),
  };
}

export function parseSpotsSnapshot(value: unknown, apiBaseUrl: string): SpotsSnapshot {
  const record = expectRecord(value);
  const spots = expectArray(record.spots, 500).map((spot) => parseSpot(spot, apiBaseUrl));
  const ids = new Set(spots.map(({ id }) => id));
  const slugs = new Set(spots.map(({ slug }) => slug));
  if (ids.size !== spots.length || slugs.size !== spots.length) {
    return invalidPayload();
  }
  return {
    contentVersion: expectIsoDateTime(record.content_version),
    spots,
  };
}

export function createSpotsService(dependencies: {
  client: CacheClient;
  apiBaseUrl: string;
}) {
  const cache = new Map<SupportedLocale, {
    etag: string;
    snapshot: SpotsSnapshot;
  }>();

  return {
    async list(locale: SupportedLocale, signal?: AbortSignal): Promise<SpotsSnapshot> {
      const cached = cache.get(locale);
      const result = await dependencies.client.cacheAware<unknown>('/api/spots', {
        authenticated: false,
        locale,
        ...(cached === undefined ? {} : { ifNoneMatch: cached.etag }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (result.status === 'not_modified') {
        return cached?.snapshot ?? invalidPayload();
      }

      const snapshot = parseSpotsSnapshot(result.data, dependencies.apiBaseUrl);
      if (result.etag !== null) {
        cache.set(locale, { etag: result.etag, snapshot });
      }
      return snapshot;
    },
  };
}
