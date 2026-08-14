import { describe, expect, it } from "vitest";

import { parsePolicyAcceptanceInput } from "@/server/policies/input";

describe("policy acceptance input", () => {
  it("requires one current-version acceptance for each consent policy", () => {
    expect(parsePolicyAcceptanceInput({
      acceptances: [
        { type: "terms_of_use", version: "1.0", locale: "ko" },
        { type: "community_guidelines", version: "1.0", locale: "en" },
      ],
    })).toEqual({
      acceptances: [
        { type: "terms_of_use", version: "1.0", locale: "ko" },
        { type: "community_guidelines", version: "1.0", locale: "en" },
      ],
    });
  });

  it("rejects duplicate policy types and unknown keys", () => {
    expect(() => parsePolicyAcceptanceInput({
      acceptances: [
        { type: "terms_of_use", version: "1.0", locale: "ko" },
        { type: "terms_of_use", version: "1.0", locale: "en", consent: true },
      ],
    })).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
});
