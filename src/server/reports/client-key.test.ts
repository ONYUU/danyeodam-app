import { afterEach, describe, expect, it, vi } from "vitest";

import { createPublicReportClientKey } from "@/server/reports/client-key";

const secret = "a-secret-that-is-at-least-thirty-two-characters";

describe("public report client key", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses a trusted Vercel client address without exposing it", () => {
    const headers = new Headers({
      "x-vercel-id": "icn1::test",
      "x-forwarded-for": "203.0.113.10",
    });
    const first = createPublicReportClientKey(headers, secret);
    const second = createPublicReportClientKey(headers, secret);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(second);
    expect(first).not.toContain("203.0.113.10");
  });

  it("keeps one rate key across UTC midnight", () => {
    const headers = new Headers({
      "x-vercel-id": "icn1::test",
      "x-forwarded-for": "203.0.113.10",
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T23:59:59.999Z"));
    const beforeMidnight = createPublicReportClientKey(headers, secret);
    vi.setSystemTime(new Date("2026-08-13T00:00:00.001Z"));
    expect(createPublicReportClientKey(headers, secret)).toBe(beforeMidnight);
  });

  it("does not trust a client-supplied forwarded address outside Vercel", () => {
    const forgedA = createPublicReportClientKey(
      new Headers({ "x-forwarded-for": "203.0.113.10" }),
      secret,
    );
    const forgedB = createPublicReportClientKey(
      new Headers({ "x-forwarded-for": "198.51.100.8" }),
      secret,
    );
    expect(forgedA).toBe(forgedB);
  });
});
