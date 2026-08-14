import { describe, expect, it } from "vitest";

import { parseLinkEmailInput } from "@/server/auth/link-email-input";

describe("link email input", () => {
  it("normalizes a valid address", () => {
    expect(parseLinkEmailInput({
      email: "Person@Example.COM",
      flow_id: "11111111-1111-4111-8111-111111111111",
      code_challenge: "A".repeat(43),
      code_challenge_method: "s256",
    })).toEqual({
      email: "person@example.com",
      flow_id: "11111111-1111-4111-8111-111111111111",
      code_challenge: "A".repeat(43),
      code_challenge_method: "s256",
    });
  });

  it.each(["not-an-email", "@example.com", `${"a".repeat(250)}@x.test`])(
    "rejects an invalid address",
    (email) => {
      expect(() => parseLinkEmailInput({
        email,
        flow_id: "11111111-1111-4111-8111-111111111111",
        code_challenge: "A".repeat(43),
        code_challenge_method: "s256",
      })).toThrowError(
        expect.objectContaining({ code: "VALIDATION_FAILED" }),
      );
    },
  );

  it.each([
    [{ flow_id: "not-a-v4-uuid" }],
    [{ code_challenge: "too-short" }],
    [{ code_challenge: `${"A".repeat(42)}=` }],
    [{ code_challenge_method: "plain" }],
    [{ code_verifier: "must-never-cross-the-api-boundary" }],
  ])("rejects malformed, plain, or extra PKCE fields", (override) => {
    expect(() => parseLinkEmailInput({
      email: "person@example.com",
      flow_id: "11111111-1111-4111-8111-111111111111",
      code_challenge: "A".repeat(43),
      code_challenge_method: "s256",
      ...override,
    })).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
});
