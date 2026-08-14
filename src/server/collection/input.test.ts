import { describe, expect, it } from "vitest";

import { parseCollectionQuery } from "@/server/collection/input";

describe("collection query", () => {
  it("defaults to fifty and accepts the documented range", () => {
    expect(parseCollectionQuery("https://example.test/api/me/collection")).toEqual({ limit: 50 });
    expect(parseCollectionQuery("https://example.test/api/me/collection?limit=100&cursor=opaque"))
      .toEqual({ limit: 100, cursor: "opaque" });
  });

  it.each(["0", "101", "1.5", "+1", "01", "", "abc"])(
    "rejects invalid limit %s",
    (limit) => {
      expect(() => parseCollectionQuery(
        `https://example.test/api/me/collection?limit=${encodeURIComponent(limit)}`,
      )).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED", status: 400 }));
    },
  );

  it("rejects duplicate parameters and an empty cursor", () => {
    expect(() => parseCollectionQuery(
      "https://example.test/api/me/collection?limit=1&limit=2",
    )).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => parseCollectionQuery(
      "https://example.test/api/me/collection?cursor=",
    )).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
});
