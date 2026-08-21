import { describe, expect, it, vi } from "vitest";

import type { BonusPackRepository } from "@/server/bonus-packs/repository";
import {
  getBonusPack,
  listBonusPacks,
  listCardInventory,
  openBonusPack,
} from "@/server/bonus-packs/service";

const authUserId = "11111111-1111-4111-8111-111111111111";
const packId = "22222222-2222-4222-8222-222222222222";
const cardId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const cursorSecret = "test-only-bonus-pack-cursor-secret-0001";
const localized = {
  ko: "서울", en: "Seoul", ja: "ソウル",
  "zh-Hans": "首尔", "zh-Hant": "首爾", vi: "Seoul",
};
const sealed = {
  id: packId,
  status: "sealed" as const,
  issued_at: "2026-08-15T00:00:00.000Z",
  date_kst: "2026-08-15",
};
const opened = {
  ...sealed,
  status: "opened" as const,
  opened_at: "2026-08-15T00:01:00.000Z",
  card: {
    id: cardId,
    rarity: "special" as const,
    title: localized,
    asset_path: "cards/private/storage-path.webp",
    color_hex: "#AABBCC",
  },
};

function createRepository(
  overrides: Partial<BonusPackRepository> = {},
): BonusPackRepository {
  return {
    list: vi.fn(async () => ({
      status: "ready" as const,
      items: [],
      sealed_count: 0,
      has_more: false,
      next_anchor: null,
    })),
    get: vi.fn(async () => ({ status: "not_found" as const })),
    open: vi.fn(async () => ({ status: "not_found" as const })),
    listInventory: vi.fn(async () => ({
      status: "ready" as const,
      items: [],
      has_more: false,
      next_anchor: null,
    })),
    ...overrides,
  };
}

describe("bonus pack service", () => {
  it("projects sealed and opened list items without leaking storage or guarantee data", async () => {
    const list = vi.fn(async () => ({
      status: "ready" as const,
      items: [sealed, opened],
      sealed_count: 87,
      has_more: true,
      next_anchor: { issued_at: opened.issued_at, id: opened.id },
    }));
    const first = await listBonusPacks({
      authUserId,
      limit: 2,
      cursorSecret,
    }, createRepository({ list }));

    expect(first.items[0]).toEqual(sealed);
    expect(first.items[1]).toEqual({
      id: packId,
      status: "opened",
      issued_at: opened.issued_at,
      date_kst: opened.date_kst,
      opened_at: opened.opened_at,
      card: {
        id: cardId,
        rarity: "special",
        title: localized,
        image_url: `/api/me/special-card-assets/${cardId}`,
        color_hex: "#AABBCC",
      },
    });
    expect(JSON.stringify(first)).not.toContain("asset_path");
    expect(JSON.stringify(first.items[0])).not.toMatch(/rarity|card|result|guarantee/u);
    expect(first.sealed_count).toBe(87);
    expect(first.page).toEqual({ has_more: true, next_cursor: expect.any(String) });

    const next = await listBonusPacks({
      authUserId,
      limit: 2,
      cursor: first.page.next_cursor ?? undefined,
      cursorSecret,
    }, createRepository({ list }));
    expect(list).toHaveBeenLastCalledWith({
      authUserId,
      limit: 2,
      beforeIssuedAt: opened.issued_at,
      beforeBonusPackId: opened.id,
    });
    expect(first.sealed_count).toBeGreaterThan(first.items.length);
    expect(next.sealed_count).toBe(first.sealed_count);
  });

  it("maps detail ownership and database integrity failures without exposing internals", async () => {
    await expect(getBonusPack(
      { authUserId, bonusPackId: packId },
      createRepository({ get: vi.fn(async () => ({ status: "not_found" as const })) }),
    )).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

    await expect(getBonusPack(
      { authUserId, bonusPackId: packId },
      createRepository({ get: vi.fn(async () => ({ status: "unauthorized" as const })) }),
    )).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });

    await expect(getBonusPack(
      { authUserId, bonusPackId: packId },
      createRepository({ get: vi.fn(async () => ({ status: "invalid" as const })) }),
    )).rejects.toMatchObject({ code: "INTERNAL", status: 500 });
  });

  it("opens only with server-returned data and maps idempotency conflicts", async () => {
    const open = vi.fn(async () => ({
      status: "ready" as const,
      bonus_pack: opened,
    }));
    const result = await openBonusPack({
      authUserId,
      bonusPackId: packId,
      clientRequestId: requestId,
    }, createRepository({ open }));

    expect(open).toHaveBeenCalledWith({ authUserId, bonusPackId: packId, clientRequestId: requestId });
    expect(result.bonus_pack).toMatchObject({
      status: "opened",
      card: { id: cardId, rarity: "special" },
    });
    expect(JSON.stringify(result)).not.toContain("asset_path");

    await expect(openBonusPack({
      authUserId,
      bonusPackId: packId,
      clientRequestId: requestId,
    }, createRepository({
      open: vi.fn(async () => ({ status: "idempotency_conflict" as const })),
    }))).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  });

  it("returns quantity-stacked inventory with a domain-specific cursor", async () => {
    const listInventory = vi.fn(async () => ({
      status: "ready" as const,
      items: [{
        card: opened.card,
        quantity: 3,
        first_acquired_at: "2026-08-13T00:00:00.000Z",
        last_acquired_at: "2026-08-15T00:01:00.000Z",
      }],
      has_more: true,
      next_anchor: {
        last_acquired_at: "2026-08-15T00:01:00.000Z",
        card_id: cardId,
      },
    }));
    const result = await listCardInventory({
      authUserId,
      limit: 1,
      cursorSecret,
    }, createRepository({ listInventory }));

    expect(result.items[0]).toMatchObject({
      card: { id: cardId, rarity: "special" },
      quantity: 3,
    });
    expect(JSON.stringify(result)).not.toContain("asset_path");
    expect(result.page).toEqual({ has_more: true, next_cursor: expect.any(String) });
  });

  it("keeps common art on the public endpoint and special art on the owned endpoint", async () => {
    const commonResult = await getBonusPack(
      { authUserId, bonusPackId: packId },
      createRepository({
        get: vi.fn(async () => ({
          status: "ready" as const,
          bonus_pack: {
            ...opened,
            card: { ...opened.card, rarity: "common" as const },
          },
        })),
      }),
    );
    expect(commonResult.bonus_pack).toMatchObject({
      card: { image_url: `/api/card-assets/${cardId}` },
    });

    const specialResult = await getBonusPack(
      { authUserId, bonusPackId: packId },
      createRepository({
        get: vi.fn(async () => ({ status: "ready" as const, bonus_pack: opened })),
      }),
    );
    expect(specialResult.bonus_pack).toMatchObject({
      card: { image_url: `/api/me/special-card-assets/${cardId}` },
    });
  });

  it("fails closed when a page boundary is inconsistent", async () => {
    await expect(listBonusPacks({
      authUserId,
      limit: 50,
      cursorSecret,
    }, createRepository({
      list: vi.fn(async () => ({
        status: "ready" as const,
        items: [],
        sealed_count: 87,
        has_more: true,
        next_anchor: null,
      })),
    }))).rejects.toMatchObject({ code: "INTERNAL" });
  });
});
