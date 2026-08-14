import { describe, expect, it } from "vitest";

import {
  constantTimeDigestMatch,
  hashAccountDeletionSecret,
  publicRateLimitSubjectDigest,
  trustedClientIp,
} from "@/server/account-deletion/secret";

describe("account deletion secrets", () => {
  it("hashes bearer status tokens and compares only fixed-length digests", () => {
    const digest = hashAccountDeletionSecret("A".repeat(43));
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(constantTimeDigestMatch(digest, digest)).toBe(true);
    expect(constantTimeDigestMatch(digest, hashAccountDeletionSecret("B".repeat(43))))
      .toBe(false);
    expect(constantTimeDigestMatch("short", digest)).toBe(false);
  });

  it("uses only the Vercel-owned forwarded header in production", () => {
    const request = new Request("https://example.test", {
      headers: {
        "x-vercel-forwarded-for": "203.0.113.9",
        "x-forwarded-for": "198.51.100.4",
      },
    });
    expect(trustedClientIp(request, { VERCEL: "1", NODE_ENV: "production" }))
      .toBe("203.0.113.9");
    expect(() => trustedClientIp(
      new Request("https://example.test", {
        headers: { "x-forwarded-for": "198.51.100.4" },
      }),
      { VERCEL: "1", NODE_ENV: "production" },
    )).toThrowError(expect.objectContaining({ code: "INTERNAL" }));
  });

  it("HMACs a fixed scope domain and trusted IP without a midnight reset", () => {
    const digest = publicRateLimitSubjectDigest({
      ip: "203.0.113.9",
      scope: "account_deletion_status_ip",
      secret: "s".repeat(32),
    });
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(digest).not.toContain("203.0.113.9");
    expect(publicRateLimitSubjectDigest({
      ip: "203.0.113.9",
      scope: "account_deletion_recovery_ip",
      secret: "s".repeat(32),
    })).not.toBe(digest);
  });
});
