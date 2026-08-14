import { describe, expect, it } from "vitest";

import { normalizeLandingReference } from "@/server/events/public-events";

describe("normalizeLandingReference", () => {
  it.each(["sns", "share", "direct"] as const)("keeps %s", (reference) => {
    expect(normalizeLandingReference(reference)).toBe(reference);
  });

  it("uses the first value for repeated query parameters", () => {
    expect(normalizeLandingReference(["share", "sns"])).toBe("share");
  });

  it.each([undefined, "unknown", "", []])("defaults %j to direct", (value) => {
    expect(normalizeLandingReference(value)).toBe("direct");
  });
});
