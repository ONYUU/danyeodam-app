import { describe, expect, it } from 'vitest';

import { ApiTransportError } from './client';
import { mergeCollectionItems, parseCollectionPage } from './collection';

const localized = {
  ko: '경복궁',
  en: 'Gyeongbokgung',
  ja: '景福宮',
  'zh-Hans': '景福宫',
  'zh-Hant': '景福宮',
  vi: 'Cung Gyeongbok',
};

const item = {
  acquisition: {
    id: '11111111-1111-4111-8111-111111111111',
    spot_id: '22222222-2222-4222-8222-222222222222',
    card_id: '33333333-3333-4333-8333-333333333333',
    type: 'retro',
    acquired_at: '2026-08-12T00:00:00.000Z',
    date_kst: '2026-08-12',
  },
  spot: { slug: 'gyeongbokgung', name: localized },
  card: {
    title: localized,
    image_url: '/api/card-assets/33333333-3333-4333-8333-333333333333',
    color_hex: '#123456',
  },
  personal_card: {
    id: '44444444-4444-4444-8444-444444444444',
    caption: 'A quiet morning',
    photo_url: '/api/personal-cards/44444444-4444-4444-8444-444444444444/photo',
    created_at: '2026-08-12T01:00:00.000Z',
    share: {
      status: 'active',
      slug: 'Abcdefghijklmnopqrstuv',
      url: 'https://danyeodam.example/share#Abcdefghijklmnopqrstuv',
      reason_code: null,
    },
  },
};

function page(overrides: Record<string, unknown> = {}) {
  return {
    items: [item],
    page: { next_cursor: null, has_more: false },
    stats: { total_acquisitions: 1, spots_visited: 1, personal_cards: 1 },
    ...overrides,
  };
}

describe('collection service', () => {
  it('parses collection pages without retaining server field names', () => {
    const parsed = parseCollectionPage(page(), 'https://api.example.com');

    expect(parsed.items[0]?.acquisition.type).toBe('retro');
    expect(parsed.items[0]?.card.imageUrl).toBe(
      'https://api.example.com/api/card-assets/33333333-3333-4333-8333-333333333333',
    );
    expect(parsed.items[0]?.personalCard?.share.url).toBe(
      'https://danyeodam.example/share#Abcdefghijklmnopqrstuv',
    );
  });

  it('rejects pagination and ownership-proxy inconsistencies', () => {
    expect(() => parseCollectionPage(page({
      page: { next_cursor: null, has_more: true },
    }), 'https://api.example.com')).toThrow(ApiTransportError);
    expect(() => parseCollectionPage(page({
      items: [{
        ...item,
        personal_card: {
          ...item.personal_card,
          photo_url: '/api/personal-cards/55555555-5555-4555-8555-555555555555/photo',
        },
      }],
    }), 'https://api.example.com')).toThrow(ApiTransportError);
  });

  it('parses the canonical pending and taken-down share states without a public URL', () => {
    for (const status of ['pending', 'taken_down'] as const) {
      const parsed = parseCollectionPage(page({
        items: [{
          ...item,
          personal_card: {
            ...item.personal_card,
            share: {
              ...item.personal_card.share,
              status,
              url: null,
            },
          },
        }],
      }), 'https://api.example.com');
      expect(parsed.items[0]?.personalCard?.share.status).toBe(status);
      expect(parsed.items[0]?.personalCard?.share.url).toBeNull();
    }
  });

  it('deduplicates overlapping cursor pages while preserving order', () => {
    const first = parseCollectionPage(page(), 'https://api.example.com').items[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      return;
    }
    const second = {
      ...first,
      acquisition: {
        ...first.acquisition,
        id: '55555555-5555-4555-8555-555555555555',
      },
    };

    expect(mergeCollectionItems([first], [first, second]).map(({ acquisition }) => acquisition.id))
      .toEqual([first.acquisition.id, second.acquisition.id]);
  });
});
