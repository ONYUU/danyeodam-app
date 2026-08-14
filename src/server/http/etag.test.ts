import { describe, expect, it } from "vitest";

import { contentVersionEtag, ifNoneMatchMatches } from "@/server/http/etag";

describe("HTTP entity tags", () => {
  it("generates a stable strong tag without exposing the raw version", () => {
    const version = "2026-08-12T12:34:56.000Z";
    expect(contentVersionEtag(version)).toBe(contentVersionEtag(version));
    expect(contentVersionEtag(version)).not.toContain(version);
  });

  it("uses weak comparison for If-None-Match and accepts lists or wildcard", () => {
    const etag = contentVersionEtag("version-one");
    expect(ifNoneMatchMatches(null, etag)).toBe(false);
    expect(ifNoneMatchMatches(`"other", W/${etag}`, etag)).toBe(true);
    expect(ifNoneMatchMatches("*", etag)).toBe(true);
    expect(ifNoneMatchMatches("malformed", etag)).toBe(false);
  });
});
