import { describe, expect, it } from "vitest";

import {
  bonusPackListResultSchema,
  openedBonusPackSchema,
  ownedSpecialCardAssetResultSchema,
  sealedBonusPackSchema,
} from "@/server/bonus-packs/db-contract";

const localized = {
  ko: "서울", en: "Seoul", ja: "ソウル",
  "zh-Hans": "首尔", "zh-Hant": "首爾", vi: "Seoul",
};

const sealed = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "sealed" as const,
  issued_at: "2026-08-15T00:00:00.000Z",
  date_kst: "2026-08-15",
};

describe("bonus pack database contract", () => {
  it("accepts the exact sealed projection", () => {
    expect(sealedBonusPackSchema.parse(sealed)).toEqual(sealed);
  });

  it.each([
    { rarity: "special" },
    { card_id: "22222222-2222-4222-8222-222222222222" },
    { result: { rarity: "special" } },
    { guarantee: true },
    { guarantee_streak: 4 },
  ])("fails closed if a sealed pack carries result metadata: %j", (extra) => {
    expect(() => sealedBonusPackSchema.parse({ ...sealed, ...extra })).toThrow();
    expect(() => bonusPackListResultSchema.parse({
      status: "ready",
      items: [{ ...sealed, ...extra }],
      sealed_count: 1,
      has_more: false,
      next_anchor: null,
    })).toThrow();
  });

  it("requires a nonnegative safe account-wide sealed count", () => {
    const ready = {
      status: "ready",
      items: [sealed],
      sealed_count: 87,
      has_more: true,
      next_anchor: {
        issued_at: sealed.issued_at,
        id: sealed.id,
      },
    };
    const parsed = bonusPackListResultSchema.parse(ready);
    expect(parsed).toMatchObject({ status: "ready", sealed_count: 87 });
    expect(() => bonusPackListResultSchema.parse({ ...ready, sealed_count: -1 })).toThrow();
    expect(() => bonusPackListResultSchema.parse({
      ...ready,
      sealed_count: Number.MAX_SAFE_INTEGER + 1,
    })).toThrow();
  });

  it("allows an opened result but keeps the database asset path explicit", () => {
    const opened = openedBonusPackSchema.parse({
      ...sealed,
      status: "opened",
      opened_at: "2026-08-15T00:01:00.000Z",
      card: {
        id: "22222222-2222-4222-8222-222222222222",
        rarity: "special",
        title: localized,
        asset_path: "cards/special/seoul.webp",
        color_hex: "#AABBCC",
      },
    });
    expect(opened.card.rarity).toBe("special");
  });

  it("accepts only the dedicated private bucket for an owned special asset", () => {
    const result = {
      status: "found" as const,
      bucket: "special-card-assets" as const,
      asset_path: "cards/special/seoul.webp",
    };
    expect(ownedSpecialCardAssetResultSchema.parse(result)).toEqual(result);
    expect(() => ownedSpecialCardAssetResultSchema.parse({
      ...result,
      bucket: "card-assets",
    })).toThrow();
    expect(() => ownedSpecialCardAssetResultSchema.parse({
      status: "found",
      asset_path: result.asset_path,
    })).toThrow();
  });
});
