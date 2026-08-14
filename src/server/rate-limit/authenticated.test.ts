import { describe, expect, it } from "vitest";

import { throwIfAuthenticatedRateLimited } from "@/server/rate-limit/authenticated";

describe("authenticated API rate-limit result helper", () => {
  it("ignores every domain result other than the rate-limited discriminator", () => {
    expect(() => throwIfAuthenticatedRateLimited({ status: "ready" })).not.toThrow();
    expect(() => throwIfAuthenticatedRateLimited({ status: "unauthorized" })).not.toThrow();
    expect(() => throwIfAuthenticatedRateLimited(null)).not.toThrow();
  });

  it("maps a strict bounded database denial to the canonical 429 details", () => {
    expect(() => throwIfAuthenticatedRateLimited({
      status: "rate_limited",
      retry_after_seconds: 17,
    })).toThrowError(expect.objectContaining({
      code: "RATE_LIMITED",
      status: 429,
      details: { retry_after_seconds: 17 },
    }));
  });

  it.each([
    { status: "rate_limited" },
    { status: "rate_limited", retry_after_seconds: 0 },
    { status: "rate_limited", retry_after_seconds: 61 },
    { status: "rate_limited", retry_after_seconds: 1.5 },
    { status: "rate_limited", retry_after_seconds: 17, extra: true },
  ])("fails closed for a malformed denial: %j", (result) => {
    expect(() => throwIfAuthenticatedRateLimited(result)).toThrowError(
      expect.objectContaining({ code: "INTERNAL", status: 500 }),
    );
  });
});
