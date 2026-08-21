import { describe, expect, it } from "vitest";

import {
  assertNoQueryParameters,
  parseBonusPackId,
  parseBonusPackListQuery,
  parseCardInventoryQuery,
  parseOpenBonusPackInput,
  parseSpecialCardId,
} from "@/server/bonus-packs/input";

const packId = "11111111-1111-4111-8111-111111111111";
const requestId = "abcdefab-cdef-4abc-8abc-abcdefabcdef";

describe("bonus pack inputs", () => {
  it("accepts only the bounded list query surface", () => {
    expect(parseBonusPackListQuery("https://api.example.test/api/me/bonus-packs"))
      .toEqual({ limit: 50 });
    expect(parseCardInventoryQuery(
      "https://api.example.test/api/me/card-inventory?limit=100&cursor=opaque",
    )).toEqual({ limit: 100, cursor: "opaque" });
  });

  it.each([
    "?limit=0",
    "?limit=101",
    "?limit=01",
    "?limit=1&limit=2",
    "?cursor=a&cursor=b",
    "?cursor=",
    `?cursor=${"a".repeat(1_025)}`,
    "?unexpected=true",
  ])("rejects an expanded or malformed page query: %s", (query) => {
    expect(() => parseBonusPackListQuery(`https://api.example.test/${query}`))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("parses a resource UUID and maps a malformed path to not found", () => {
    expect(parseBonusPackId(packId)).toBe(packId);
    expect(parseSpecialCardId(packId)).toBe(packId);
    expect(() => parseBonusPackId("not-an-id"))
      .toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("rejects every query parameter on detail and open routes", () => {
    expect(() => assertNoQueryParameters("https://api.example.test/path"))
      .not.toThrow();
    expect(() => assertNoQueryParameters("https://api.example.test/path?rarity=special"))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("accepts only an exact lowercase UUIDv4 open payload", () => {
    expect(parseOpenBonusPackInput({ client_request_id: requestId }))
      .toEqual({ client_request_id: requestId });

    for (const value of [
      {},
      { client_request_id: "22222222-2222-1222-8222-222222222222" },
      { client_request_id: requestId.toUpperCase() },
      { client_request_id: requestId, card_id: packId },
      { client_request_id: requestId, rarity: "special" },
    ]) {
      expect(() => parseOpenBonusPackInput(value))
        .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    }
  });
});
