import { describe, expect, it, vi } from 'vitest';

import type { OpenedBonusPack } from '@/api/bonus-packs';
import { ApiTransportError } from '@/api/client';
import type { SupportedLocale } from '@/i18n/locales';

import { createBonusPackOpenOperation } from './open-operation';

const packId = '11111111-1111-4111-8111-111111111111';
const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const opened = {
  id: packId,
  status: 'opened',
  issuedAt: '2026-08-15T01:00:00.000Z',
  dateKst: '2026-08-15',
  openedAt: '2026-08-15T01:01:00.000Z',
  card: {
    id: '22222222-2222-4222-8222-222222222222',
    rarity: 'special',
    title: {
      ko: '특별 카드',
      en: 'Special card',
      ja: 'スペシャルカード',
      'zh-Hans': '特别卡',
      'zh-Hant': '特別卡',
      vi: 'Thẻ đặc biệt',
    },
    imageUrl: 'https://api.example.com/api/me/special-card-assets/22222222-2222-4222-8222-222222222222',
    colorHex: '#A34F3D',
  },
} satisfies OpenedBonusPack;

describe('bonus pack open operation', () => {
  it('reuses one client request id after an ambiguous network failure', async () => {
    const open = vi.fn()
      .mockRejectedValueOnce(new ApiTransportError('NETWORK_ERROR'))
      .mockResolvedValueOnce(opened);
    const createClientRequestId = vi.fn(() => requestId);
    const operation = createBonusPackOpenOperation({ createClientRequestId, open });
    const signal = new AbortController().signal;

    await expect(operation.run({ packId, locale: 'ko', signal })).rejects.toThrow();
    await expect(operation.run({ packId, locale: 'ko', signal })).resolves.toBe(opened);
    expect(createClientRequestId).toHaveBeenCalledTimes(1);
    expect(open.mock.calls.map(([input]) => input.clientRequestId))
      .toEqual([requestId, requestId]);
  });

  it('starts a new request identity for a different pack', async () => {
    const open = vi.fn(async (input: {
      packId: string;
      clientRequestId: string;
      locale: SupportedLocale;
      signal: AbortSignal;
    }): Promise<OpenedBonusPack> => ({
      ...opened,
      id: input.packId,
    }));
    const createClientRequestId = vi.fn()
      .mockReturnValueOnce(requestId)
      .mockReturnValueOnce('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const operation = createBonusPackOpenOperation({ createClientRequestId, open });
    const signal = new AbortController().signal;
    await operation.run({ packId, locale: 'en', signal });
    await operation.run({
      packId: '33333333-3333-4333-8333-333333333333',
      locale: 'en',
      signal,
    });
    expect(createClientRequestId).toHaveBeenCalledTimes(2);
  });
});
