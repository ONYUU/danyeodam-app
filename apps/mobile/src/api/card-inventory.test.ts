import { describe, expect, it } from 'vitest';

import { ApiTransportError } from './client';
import { mergeInventoryItems, parseInventoryPage } from './card-inventory';

const cardId = '22222222-2222-4222-8222-222222222222';
const item = {
  card: {
    id: cardId,
    rarity: 'common',
    title: {
      ko: '경복궁',
      en: 'Gyeongbokgung',
      ja: '景福宮',
      'zh-Hans': '景福宫',
      'zh-Hant': '景福宮',
      vi: 'Cung Gyeongbok',
    },
    image_url: `/api/card-assets/${cardId}`,
    color_hex: '#356A5A',
  },
  quantity: 3,
  first_acquired_at: '2026-08-13T01:00:00.000Z',
  last_acquired_at: '2026-08-15T01:00:00.000Z',
};

describe('card inventory service', () => {
  it('keeps stacked quantities separate from visit acquisition records', () => {
    const parsed = parseInventoryPage({
      items: [item],
      page: { next_cursor: null, has_more: false },
    }, 'https://api.example.com');
    expect(parsed.items[0]).toMatchObject({
      quantity: 3,
      card: { rarity: 'common' },
    });
    expect(parsed.items[0]).not.toHaveProperty('acquisition');
  });

  it('rejects zero quantities, reverse timestamps, and duplicate cards', () => {
    const envelope = (items: unknown[]) => ({
      items,
      page: { next_cursor: null, has_more: false },
    });
    expect(() => parseInventoryPage(envelope([{ ...item, quantity: 0 }]), 'https://api.example.com'))
      .toThrow(ApiTransportError);
    expect(() => parseInventoryPage(envelope([{
      ...item,
      last_acquired_at: '2026-08-12T01:00:00.000Z',
    }]), 'https://api.example.com')).toThrow(ApiTransportError);
    expect(() => parseInventoryPage(envelope([item, item]), 'https://api.example.com'))
      .toThrow(ApiTransportError);
    expect(() => parseInventoryPage(envelope([{
      ...item,
      card: { ...item.card, rarity: 'special' },
    }]), 'https://api.example.com')).toThrow(ApiTransportError);
    expect(() => parseInventoryPage(envelope([{
      ...item,
      internal_asset_path: 'private/should-never-arrive.webp',
    }]), 'https://api.example.com')).toThrow(ApiTransportError);
  });

  it('accepts special art only through the authenticated owner route', () => {
    const parsed = parseInventoryPage({
      items: [{
        ...item,
        card: {
          ...item.card,
          rarity: 'special',
          image_url: `/api/me/special-card-assets/${cardId}`,
        },
      }],
      page: { next_cursor: null, has_more: false },
    }, 'https://api.example.com');
    expect(parsed.items[0]?.card.imageUrl).toBe(
      `https://api.example.com/api/me/special-card-assets/${cardId}`,
    );
  });

  it('merges cursor pages by card identity', () => {
    const first = parseInventoryPage({
      items: [item],
      page: { next_cursor: null, has_more: false },
    }, 'https://api.example.com').items[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const second = {
      ...first,
      card: {
        ...first.card,
        id: '33333333-3333-4333-8333-333333333333',
      },
    };
    expect(mergeInventoryItems([first], [first, second])).toHaveLength(2);
  });
});
