import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from './client';
import { ApiTransportError } from './client';
import {
  createBonusPackService,
  mergeBonusPacks,
  parseBonusPack,
  parseBonusPackPage,
} from './bonus-packs';

const apiBaseUrl = 'https://api.example.com';
const packId = '11111111-1111-4111-8111-111111111111';
const reviewerPackId = '11111111-1111-5111-8111-111111111111';
const cardId = '22222222-2222-4222-8222-222222222222';
const reviewerCardId = '22222222-2222-5222-8222-222222222222';
const localized = {
  ko: '경복궁 특별 카드',
  en: 'Gyeongbokgung Special Card',
  ja: '景福宮スペシャルカード',
  'zh-Hans': '景福宫特别卡',
  'zh-Hant': '景福宮特別卡',
  vi: 'Thẻ đặc biệt Gyeongbokgung',
};
const sealed = {
  id: packId,
  status: 'sealed',
  issued_at: '2026-08-15T01:00:00.000Z',
  date_kst: '2026-08-15',
};
const opened = {
  ...sealed,
  status: 'opened',
  opened_at: '2026-08-15T01:01:00.000Z',
  card: {
    id: cardId,
    rarity: 'special',
    title: localized,
    image_url: `/api/me/special-card-assets/${cardId}`,
    color_hex: '#A34F3D',
  },
};

describe('bonus pack service', () => {
  it('keeps a sealed response free of result and probability fields', () => {
    expect(parseBonusPack(sealed, apiBaseUrl)).toEqual({
      id: packId,
      status: 'sealed',
      issuedAt: sealed.issued_at,
      dateKst: sealed.date_kst,
    });

    for (const leaked of [
      { card: opened.card },
      { rarity: 'special' },
      { was_guaranteed: true },
      { probability: 0.2 },
      { opaque_result: 'special' },
    ]) {
      expect(() => parseBonusPack({ ...sealed, ...leaked }, apiBaseUrl))
        .toThrow(ApiTransportError);
    }
  });

  it('parses an opened card only after the opened state is returned', () => {
    const parsed = parseBonusPack(opened, apiBaseUrl);
    expect(parsed.status).toBe('opened');
    if (parsed.status !== 'opened') return;
    expect(parsed.card.rarity).toBe('special');
    expect(parsed.card.imageUrl).toBe(
      `${apiBaseUrl}/api/me/special-card-assets/${cardId}`,
    );
    expect(() => parseBonusPack({ ...opened, was_guaranteed: false }, apiBaseUrl))
      .toThrow(ApiTransportError);
    expect(() => parseBonusPack({
      ...opened,
      card: { ...opened.card, image_url: `/api/card-assets/${cardId}` },
    }, apiBaseUrl)).toThrow(ApiTransportError);
  });

  it('validates signed pagination and rejects duplicate packs', () => {
    const page = {
      items: [sealed],
      page: { next_cursor: 'payload.signature', has_more: true },
      sealed_count: Number.MAX_SAFE_INTEGER,
    };
    expect(parseBonusPackPage(page, apiBaseUrl)).toMatchObject({
      hasMore: true,
      sealedCount: Number.MAX_SAFE_INTEGER,
    });
    expect(() => parseBonusPackPage({
      items: [sealed, sealed],
      page: { next_cursor: null, has_more: false },
      sealed_count: 2,
    }, apiBaseUrl)).toThrow(ApiTransportError);
    for (const sealedCount of [-1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseBonusPackPage({
        items: [],
        page: { next_cursor: null, has_more: false },
        sealed_count: sealedCount,
      }, apiBaseUrl)).toThrow(ApiTransportError);
    }
    expect(() => parseBonusPackPage({
      items: [sealed],
      page: { next_cursor: null, has_more: false },
      sealed_count: 0,
    }, apiBaseUrl)).toThrow(ApiTransportError);
  });

  it('opens with a v4 client request id and never sends a local result guess', async () => {
    const client = vi.fn(async () => ({ bonus_pack: opened }));
    const service = createBonusPackService({
      client: client as unknown as ApiClient,
      apiBaseUrl,
    });
    const clientRequestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    await expect(service.open({
      packId,
      clientRequestId,
      locale: 'ko',
    })).resolves.toMatchObject({ status: 'opened', id: packId });
    expect(client).toHaveBeenCalledWith(`/api/me/bonus-packs/${packId}/open`, {
      method: 'POST',
      locale: 'ko',
      json: { client_request_id: clientRequestId },
    });

    await expect(service.open({
      packId,
      clientRequestId: clientRequestId.toUpperCase(),
      locale: 'ko',
    })).rejects.toMatchObject({ name: 'BonusPackRequestError' });
  });

  it('accepts reviewer UUIDv5 resource ids while keeping request ids on v4', async () => {
    const reviewerOpened = {
      ...opened,
      id: reviewerPackId,
      card: {
        ...opened.card,
        id: reviewerCardId,
        image_url: `/api/me/special-card-assets/${reviewerCardId}`,
      },
    };
    const client = vi.fn(async () => ({ bonus_pack: reviewerOpened }));
    const service = createBonusPackService({
      client: client as unknown as ApiClient,
      apiBaseUrl,
    });
    const clientRequestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    await expect(service.detail({
      packId: reviewerPackId,
      locale: 'ko',
    })).resolves.toMatchObject({
      id: reviewerPackId,
      card: { id: reviewerCardId },
    });
    await expect(service.open({
      packId: reviewerPackId,
      clientRequestId,
      locale: 'ko',
    })).resolves.toMatchObject({ id: reviewerPackId, status: 'opened' });
    expect(client).toHaveBeenNthCalledWith(
      1,
      `/api/me/bonus-packs/${reviewerPackId}`,
      { locale: 'ko' },
    );
    expect(client).toHaveBeenNthCalledWith(
      2,
      `/api/me/bonus-packs/${reviewerPackId}/open`,
      {
        method: 'POST',
        locale: 'ko',
        json: { client_request_id: clientRequestId },
      },
    );

    await expect(service.open({
      packId: reviewerPackId,
      clientRequestId: 'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa',
      locale: 'ko',
    })).rejects.toMatchObject({ name: 'BonusPackRequestError' });
  });

  it('deduplicates overlapping pack pages without changing existing results', () => {
    const first = parseBonusPack(sealed, apiBaseUrl);
    const second = parseBonusPack({
      ...sealed,
      id: '44444444-4444-4444-8444-444444444444',
    }, apiBaseUrl);
    expect(mergeBonusPacks([first], [first, second]).map(({ id }) => id))
      .toEqual([first.id, second.id]);
  });
});
