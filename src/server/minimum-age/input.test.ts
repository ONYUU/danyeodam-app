import { describe, expect, it } from "vitest";

import { parseMinimumAgeAttestationInput } from "@/server/minimum-age/input";

describe("minimum-age attestation input", () => {
  it("accepts only the current affirmative attestation", () => {
    expect(parseMinimumAgeAttestationInput({
      minimum_age_passed: true,
      version: "18plus-v1",
    })).toEqual({ minimum_age_passed: true, version: "18plus-v1" });
  });

  it.each([
    { minimum_age_passed: false, version: "18plus-v1" },
    { minimum_age_passed: true, version: "18plus-v0" },
    { minimum_age_passed: true, version: "18plus-v1", age: 18 },
    { minimum_age_passed: true, version: "18plus-v1", birth_year: 2000 },
    { minimum_age_passed: true, version: "18plus-v1", date_of_birth: "2000-01-01" },
  ])("rejects false, stale, or expanded personal data", (value) => {
    expect(() => parseMinimumAgeAttestationInput(value)).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });
});
