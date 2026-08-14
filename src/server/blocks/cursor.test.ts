import { describe, expect, it } from "vitest";

import { decodeBlockCursor, encodeBlockCursor } from "@/server/blocks/cursor";

const authUserId = "11111111-1111-4111-8111-111111111111";
const otherAuthUserId = "22222222-2222-4222-8222-222222222222";
const secret = "test-only-block-cursor-secret-000001";

describe("block cursor", () => {
  it("round-trips a signed user-bound keyset anchor", () => {
    const token = encodeBlockCursor({
      created_at: "2026-08-12T00:00:00.000Z",
      block_id: "33333333-3333-4333-8333-333333333333",
    }, authUserId, secret);
    expect(decodeBlockCursor(token, authUserId, secret)).toEqual({
      v: 1,
      created_at: "2026-08-12T00:00:00.000Z",
      block_id: "33333333-3333-4333-8333-333333333333",
    });
    expect(() => decodeBlockCursor(token, otherAuthUserId, secret)).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });

  it("rejects malformed and tampered cursors", () => {
    expect(() => decodeBlockCursor("not-a-cursor", authUserId, secret)).toThrow();
    const token = encodeBlockCursor({
      created_at: "2026-08-12T00:00:00.000Z",
      block_id: "33333333-3333-4333-8333-333333333333",
    }, authUserId, secret);
    expect(() => decodeBlockCursor(`${token}x`, authUserId, secret)).toThrow();
  });
});
