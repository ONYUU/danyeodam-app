import { describe, expect, it } from "vitest";

import {
  decodeLocationCorrectionCursor,
  decodeLocationCorrectionSubjectCursor,
  decodeLocationFactCursor,
  encodeLocationCorrectionCursor,
  encodeLocationCorrectionSubjectCursor,
  encodeLocationFactCursor,
} from "@/server/location/cursor";

const user = "11111111-1111-4111-8111-111111111111";
const otherUser = "22222222-2222-4222-8222-222222222222";
const secret = "test-location-compliance-cursor-secret-0001";

describe("location compliance cursors", () => {
  it("round-trips all privacy-rights keyset anchors", () => {
    const fact = encodeLocationFactCursor({
      collected_at: "2026-08-12T00:00:00.000Z",
      fact_id: 42,
    }, user, secret);
    expect(decodeLocationFactCursor(fact, user, secret)).toEqual({
      v: 1,
      collected_at: "2026-08-12T00:00:00.000Z",
      fact_id: 42,
    });

    const subject = encodeLocationCorrectionSubjectCursor({
      acquired_on_kst: "2026-08-11",
      acquisition_id: "33333333-3333-4333-8333-333333333333",
    }, user, secret);
    expect(decodeLocationCorrectionSubjectCursor(subject, user, secret)).toEqual({
      v: 1,
      acquired_on_kst: "2026-08-11",
      acquisition_id: "33333333-3333-4333-8333-333333333333",
    });

    const correction = encodeLocationCorrectionCursor({
      requested_at: "2026-08-12T00:00:00.000Z",
      correction_request_id: "44444444-4444-4444-8444-444444444444",
    }, user, secret);
    expect(decodeLocationCorrectionCursor(correction, user, secret)).toEqual({
      v: 1,
      requested_at: "2026-08-12T00:00:00.000Z",
      correction_request_id: "44444444-4444-4444-8444-444444444444",
    });
  });

  it.each([
    (token: string) => `${token}x`,
    () => "not-a-cursor",
    () => "a".repeat(1_025),
  ])("rejects malformed, tampered, and oversized tokens", (mutate) => {
    const token = encodeLocationCorrectionSubjectCursor({
      acquired_on_kst: "2026-08-11",
      acquisition_id: "33333333-3333-4333-8333-333333333333",
    }, user, secret);
    expect(() => decodeLocationCorrectionSubjectCursor(mutate(token), user, secret))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("binds signatures to both user and cursor domain", () => {
    const subject = encodeLocationCorrectionSubjectCursor({
      acquired_on_kst: "2026-08-11",
      acquisition_id: "33333333-3333-4333-8333-333333333333",
    }, user, secret);
    expect(() => decodeLocationCorrectionSubjectCursor(subject, otherUser, secret))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => decodeLocationFactCursor(subject, user, secret))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));

    const correction = encodeLocationCorrectionCursor({
      requested_at: "2026-08-12T00:00:00.000Z",
      correction_request_id: "44444444-4444-4444-8444-444444444444",
    }, user, secret);
    expect(() => decodeLocationCorrectionCursor(correction, otherUser, secret))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => decodeLocationCorrectionSubjectCursor(correction, user, secret))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("rejects malformed correction anchors even when correctly signed for another domain", () => {
    const subject = encodeLocationCorrectionSubjectCursor({
      acquired_on_kst: "2026-08-11",
      acquisition_id: "33333333-3333-4333-8333-333333333333",
    }, user, secret);
    expect(() => decodeLocationCorrectionCursor(subject, user, secret))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => decodeLocationCorrectionCursor("", user, secret))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
});
