import { describe, expect, it } from "vitest";

import {
  parseLocationConsentInput,
  parseLocationConsentStateInput,
  parseLocationCorrectionInput,
  parseLocationCorrectionRequestId,
  parseLocationCorrectionResolutionInput,
} from "@/server/location/input";

const factCorrection = {
  location_use_fact_id: 42,
  client_request_id: "11111111-1111-4111-8111-111111111111",
  reason: "wrong_spot",
};
const acquisitionCorrection = {
  field_acquisition_id: "22222222-2222-4222-8222-222222222222",
  client_request_id: "11111111-1111-4111-8111-111111111111",
  reason: "not_my_visit",
};

describe("location compliance inputs", () => {
  it("accepts strict six-locale consent and explicit pause/resume", () => {
    expect(parseLocationConsentInput({ version: "2026.08.1", locale: "zh-Hant" }))
      .toEqual({ version: "2026.08.1", locale: "zh-Hant" });
    expect(parseLocationConsentStateInput({ state: "paused" }))
      .toEqual({ state: "paused" });
    expect(parseLocationConsentStateInput({ state: "active" }))
      .toEqual({ state: "active" });
  });

  it("accepts exactly one owner-bound correction subject", () => {
    expect(parseLocationCorrectionInput(factCorrection)).toEqual(factCorrection);
    expect(parseLocationCorrectionInput(acquisitionCorrection)).toEqual(acquisitionCorrection);
  });

  it.each([
    {},
    { ...factCorrection, field_acquisition_id: acquisitionCorrection.field_acquisition_id },
    { ...factCorrection, details: "unbounded narrative" },
    { ...acquisitionCorrection, reason: "delete_everything" },
    { ...factCorrection, location_use_fact_id: 0 },
    { ...acquisitionCorrection, field_acquisition_id: "not-a-uuid" },
  ])("rejects ambiguous, unbounded, and malformed corrections", (value) => {
    expect(() => parseLocationCorrectionInput(value)).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });

  it("validates admin resolution and route UUIDs before database access", () => {
    expect(parseLocationCorrectionResolutionInput({ resolution: "accepted" }))
      .toEqual({ resolution: "accepted" });
    expect(parseLocationCorrectionRequestId("33333333-3333-4333-8333-333333333333"))
      .toBe("33333333-3333-4333-8333-333333333333");
    expect(() => parseLocationCorrectionResolutionInput({ resolution: "corrected" }))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => parseLocationCorrectionRequestId("not-a-uuid"))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
});
