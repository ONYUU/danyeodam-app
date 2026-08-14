import { describe, expect, it } from "vitest";

import {
  decodeCollectionCursor,
  encodeCollectionCursor,
} from "@/server/collection/cursor";

const userOne = "11111111-1111-4111-8111-111111111111";
const userTwo = "22222222-2222-4222-8222-222222222222";
const secret = "test-only-collection-cursor-secret-0001";
const anchor = {
  acquired_at: "2026-08-12T01:02:03.000Z",
  acquisition_id: "33333333-3333-4333-8333-333333333333",
};

describe("collection cursor", () => {
  it("round trips a versioned signed anchor for the same user", () => {
    const token = encodeCollectionCursor(anchor, userOne, secret);
    expect(decodeCollectionCursor(token, userOne, secret)).toEqual({ v: 1, ...anchor });
    expect(token).not.toContain(userOne);
  });

  it("rejects tampering, malformed values, and cross-user replay as 400", () => {
    const token = encodeCollectionCursor(anchor, userOne, secret);
    const tampered = `${token[0] === "A" ? "B" : "A"}${token.slice(1)}`;
    for (const invalid of [
      tampered,
      `${token}=`,
      "not-a-cursor",
      "a.b.c",
    ]) {
      expect(() => decodeCollectionCursor(invalid, userOne, secret)).toThrowError(
        expect.objectContaining({ code: "VALIDATION_FAILED", status: 400 }),
      );
    }
    expect(() => decodeCollectionCursor(token, userTwo, secret)).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED", status: 400 }),
    );
  });
});
