import { describe, expect, it } from "vitest";

import {
  decodeBonusPackCursor,
  decodeCardInventoryCursor,
  encodeBonusPackCursor,
  encodeCardInventoryCursor,
} from "@/server/bonus-packs/cursor";

const userId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const packId = "33333333-3333-4333-8333-333333333333";
const cardId = "44444444-4444-4444-8444-444444444444";
const secret = "test-only-bonus-pack-cursor-secret-0001";

describe("bonus pack cursors", () => {
  it("round-trips pack and inventory keyset anchors", () => {
    const packCursor = encodeBonusPackCursor({
      issued_at: "2026-08-15T00:00:00.000Z",
      bonus_pack_id: packId,
    }, userId, secret);
    expect(decodeBonusPackCursor(packCursor, userId, secret)).toEqual({
      v: 1,
      issued_at: "2026-08-15T00:00:00.000Z",
      bonus_pack_id: packId,
    });

    const inventoryCursor = encodeCardInventoryCursor({
      last_acquired_at: "2026-08-15T00:00:00.000Z",
      card_id: cardId,
    }, userId, secret);
    expect(decodeCardInventoryCursor(inventoryCursor, userId, secret)).toEqual({
      v: 1,
      last_acquired_at: "2026-08-15T00:00:00.000Z",
      card_id: cardId,
    });
  });

  it("binds each cursor to one user and one endpoint domain", () => {
    const packCursor = encodeBonusPackCursor({
      issued_at: "2026-08-15T00:00:00.000Z",
      bonus_pack_id: packId,
    }, userId, secret);
    expect(() => decodeBonusPackCursor(packCursor, otherUserId, secret))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => decodeCardInventoryCursor(packCursor, userId, secret))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it.each([
    (token: string) => `${token}x`,
    () => "not-a-cursor",
    () => "a".repeat(1_025),
  ])("rejects tampered, malformed, and oversized cursors", (mutate) => {
    const cursor = encodeBonusPackCursor({
      issued_at: "2026-08-15T00:00:00.000Z",
      bonus_pack_id: packId,
    }, userId, secret);
    expect(() => decodeBonusPackCursor(mutate(cursor), userId, secret))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
});
