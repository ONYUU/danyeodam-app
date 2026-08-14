import { describe, expect, it } from "vitest";

import { hasValidCronAuthorization } from "@/server/personal-cards/cron-auth";

describe("personal card maintenance cron authorization", () => {
  const secret = "a".repeat(32);

  it("accepts only the exact bearer secret", () => {
    expect(hasValidCronAuthorization(`Bearer ${secret}`, secret)).toBe(true);
    expect(hasValidCronAuthorization(`bearer ${secret}`, secret)).toBe(false);
    expect(hasValidCronAuthorization(`Bearer ${secret}x`, secret)).toBe(false);
    expect(hasValidCronAuthorization(null, secret)).toBe(false);
  });

  it("fails closed for absent or undersized configuration", () => {
    expect(hasValidCronAuthorization("Bearer anything", undefined)).toBe(false);
    expect(hasValidCronAuthorization("Bearer short", "short")).toBe(false);
  });
});
