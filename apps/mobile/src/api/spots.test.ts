import { describe, expect, it, vi } from 'vitest';

import {
  ApiTransportError,
  type ApiCacheAwareResult,
  type ApiCacheRequestOptions,
} from './client';
import { createSpotsService, parseSpotsSnapshot } from './spots';

const localized = {
  ko: '경복궁',
  en: 'Gyeongbokgung',
  ja: '景福宮',
  'zh-Hans': '景福宫',
  'zh-Hant': '景福宮',
  vi: 'Cung Gyeongbok',
};

const body = {
  content_version: '2026-08-12T00:00:00.000Z',
  spots: [{
    id: '11111111-1111-4111-8111-111111111111',
    slug: 'gyeongbokgung',
    name: localized,
    region: { code: 'seoul', name: localized },
    status: 'open',
    latitude: 37.5796,
    longitude: 126.977,
    card: {
      id: '22222222-2222-4222-8222-222222222222',
      title: localized,
      sketch_url: '/api/card-assets/22222222-2222-4222-8222-222222222222',
      color_hex: '#123456',
    },
  }],
};

describe('spots service', () => {
  it('parses a safe localized projection and derives same-origin assets', () => {
    const snapshot = parseSpotsSnapshot(body, 'https://api.danyeodam.example');

    expect(snapshot.spots[0]?.card?.imageUrl).toBe(
      'https://api.danyeodam.example/api/card-assets/22222222-2222-4222-8222-222222222222',
    );
    expect(snapshot.spots[0]?.name.vi).toBe('Cung Gyeongbok');
  });

  it('rejects malformed teaser and asset projections', () => {
    expect(() => parseSpotsSnapshot({
      ...body,
      spots: [{ ...body.spots[0], status: 'teaser' }],
    }, 'https://api.example.com')).toThrow(ApiTransportError);
    expect(() => parseSpotsSnapshot({
      ...body,
      spots: [{
        ...body.spots[0],
        card: { ...body.spots[0]?.card, sketch_url: 'https://evil.example/image' },
      }],
    }, 'https://api.example.com')).toThrow(ApiTransportError);
  });

  it('reuses a validated snapshot after a matching 304', async () => {
    const responses: ApiCacheAwareResult<unknown>[] = [
      { status: 'fresh', data: body, etag: '"v1"' },
      { status: 'not_modified', etag: '"v1"' },
    ];
    const cacheAware = vi.fn(async (
      _path: string,
      _options?: ApiCacheRequestOptions,
    ) => responses.shift() ?? { status: 'not_modified', etag: '"v1"' });
    const service = createSpotsService({
      client: {
        cacheAware: cacheAware as unknown as Parameters<
          typeof createSpotsService
        >[0]['client']['cacheAware'],
      },
      apiBaseUrl: 'https://api.example.com',
    });

    const first = await service.list('ko');
    const second = await service.list('ko');

    expect(second).toBe(first);
    expect(cacheAware.mock.calls[1]?.[1]).toMatchObject({ ifNoneMatch: '"v1"' });
  });
});
