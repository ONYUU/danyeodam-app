import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from './client';
import { ApiTransportError } from './client';
import { createAcquireService, parseAcquireSuccess } from './acquire';

const localized = {
  ko: '경복궁의 아침',
  en: 'Morning at Gyeongbokgung',
  ja: '景福宮の朝',
  'zh-Hans': '景福宫的早晨',
  'zh-Hant': '景福宮的早晨',
  vi: 'Buổi sáng ở Gyeongbokgung',
};
const spotId = '11111111-1111-4111-8111-111111111111';
const cardId = '22222222-2222-4222-8222-222222222222';
const response = {
  acquisition: {
    id: '33333333-3333-4333-8333-333333333333',
    spot_id: spotId,
    card_id: cardId,
    type: 'field',
    acquired_at: '2026-08-12T01:00:00.000Z',
  },
  card: {
    id: cardId,
    title: localized,
    image_url: `/api/card-assets/${cardId}`,
    color_hex: '#356A5A',
  },
  back: { date_kst: '2026-08-12' },
};

describe('acquire service', () => {
  it('posts raw coordinates only in the in-memory request body and validates success', async () => {
    const client = vi.fn(async () => response);
    const acquire = createAcquireService({
      client: client as unknown as ApiClient,
      apiBaseUrl: 'https://api.example.com',
    });
    const coordinates = { latitude: 37.5796, longitude: 126.977, accuracy: 12 };

    const result = await acquire({
      spotId,
      idempotencyKey: '44444444-4444-4444-8444-444444444444',
      coordinates,
      locale: 'ko',
    });

    expect(result.card.title.ko).toBe('경복궁의 아침');
    expect(result.card.imageUrl).toBe(`https://api.example.com/api/card-assets/${cardId}`);
    expect(client).toHaveBeenCalledWith('/api/acquire', {
      method: 'POST',
      locale: 'ko',
      json: {
        spot_id: spotId,
        lat: coordinates.latitude,
        lng: coordinates.longitude,
        accuracy: coordinates.accuracy,
        idempotency_key: '44444444-4444-4444-8444-444444444444',
      },
    });
  });

  it('rejects mismatched spot, card, and incomplete locale projections', () => {
    expect(() => parseAcquireSuccess({
      ...response,
      acquisition: { ...response.acquisition, spot_id: cardId },
    }, { expectedSpotId: spotId, apiBaseUrl: 'https://api.example.com' }))
      .toThrow(ApiTransportError);
    expect(() => parseAcquireSuccess({
      ...response,
      card: { ...response.card, title: { ...localized, vi: undefined } },
    }, { expectedSpotId: spotId, apiBaseUrl: 'https://api.example.com' }))
      .toThrow(ApiTransportError);
  });

  it('rejects a non-v4 idempotency key before sending coordinates', async () => {
    const client = vi.fn();
    const acquire = createAcquireService({
      client: client as unknown as ApiClient,
      apiBaseUrl: 'https://api.example.com',
    });

    await expect(acquire({
      spotId,
      idempotencyKey: '44444444-4444-1444-8444-444444444444',
      coordinates: { latitude: 37.5796, longitude: 126.977, accuracy: 12 },
      locale: 'en',
    })).rejects.toMatchObject({ name: 'AcquireRequestError' });
    expect(client).not.toHaveBeenCalled();
  });
});
