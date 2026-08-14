import { describe, expect, it } from "vitest";

import {
  parseBlockId,
  parseBlockListQuery,
  parseBlockMutationInput,
} from "@/server/blocks/input";

describe("user block input", () => {
  it("accepts only a strict logical mutation id", () => {
    expect(parseBlockMutationInput({
      client_action_id: "11111111-1111-4111-8111-111111111111",
    })).toEqual({ client_action_id: "11111111-1111-4111-8111-111111111111" });
    expect(() => parseBlockMutationInput({
      client_action_id: crypto.randomUUID(),
      owner_user_id: crypto.randomUUID(),
    })).toThrow();
  });

  it("maps malformed opaque ids to not found", () => {
    expect(() => parseBlockId("owner-id")).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("parses bounded block-list pagination and rejects ambiguous queries", () => {
    expect(parseBlockListQuery("https://example.test/api/me/blocks?limit=100&cursor=opaque"))
      .toEqual({ limit: 100, cursor: "opaque" });
    expect(parseBlockListQuery("https://example.test/api/me/blocks")).toEqual({ limit: 50 });
    expect(() => parseBlockListQuery("https://example.test/api/me/blocks?limit=101")).toThrow();
    expect(() => parseBlockListQuery(
      "https://example.test/api/me/blocks?cursor=a&cursor=b",
    )).toThrow();
  });
});
