import { describe, expect, it } from "vitest";

import {
  createAgeAttestationSetCookie,
  createAgeAttestationToken,
  PUBLIC_SHARE_AGE_COOKIE_NAME,
  PUBLIC_SHARE_AGE_MAX_AGE_SECONDS,
  requireAgeAttestation,
  verifyAgeAttestationToken,
} from "@/server/public-shares/age-attestation";

const secret = "test-only-public-share-age-hmac-secret-value";
const nowMs = Date.UTC(2026, 7, 12, 0, 0, 0);

describe("public share age attestation", () => {
  it("issues a short-lived host cookie and validates its signed token", () => {
    const token = createAgeAttestationToken(secret, nowMs);
    expect(verifyAgeAttestationToken(token, secret, nowMs)).toBe(true);
    expect(verifyAgeAttestationToken(
      token,
      secret,
      nowMs + (PUBLIC_SHARE_AGE_MAX_AGE_SECONDS - 1) * 1_000,
    )).toBe(true);
    expect(verifyAgeAttestationToken(
      token,
      secret,
      nowMs + PUBLIC_SHARE_AGE_MAX_AGE_SECONDS * 1_000,
    )).toBe(false);

    const cookie = createAgeAttestationSetCookie(secret, nowMs);
    expect(cookie).toContain(`${PUBLIC_SHARE_AGE_COOKIE_NAME}=${token}`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain(`Max-Age=${PUBLIC_SHARE_AGE_MAX_AGE_SECONDS}`);
  });

  it("rejects tampering, expiry, wrong secrets, and signed obsolete versions", () => {
    const token = createAgeAttestationToken(secret, nowMs);
    const last = token.at(-1);
    const tampered = `${token.slice(0, -1)}${last === "A" ? "B" : "A"}`;
    expect(verifyAgeAttestationToken(tampered, secret, nowMs)).toBe(false);
    expect(verifyAgeAttestationToken(token, `${secret}-other`, nowMs)).toBe(false);
    expect(verifyAgeAttestationToken(
      createAgeAttestationToken(secret, nowMs, "dob-18-v0"),
      secret,
      nowMs,
    )).toBe(false);
  });

  it("maps missing or invalid cookies to one neutral 428 response code", () => {
    const token = createAgeAttestationToken(secret, nowMs);
    expect(() => requireAgeAttestation(new Request("https://example.test"), secret, nowMs))
      .toThrowError(expect.objectContaining({
        code: "AGE_ATTESTATION_REQUIRED",
        status: 428,
      }));
    expect(() => requireAgeAttestation(new Request("https://example.test", {
      headers: { cookie: `${PUBLIC_SHARE_AGE_COOKIE_NAME}=invalid` },
    }), secret, nowMs)).toThrowError(expect.objectContaining({ code: "AGE_ATTESTATION_REQUIRED" }));
    expect(() => requireAgeAttestation(new Request("https://example.test", {
      headers: { cookie: `other=x; ${PUBLIC_SHARE_AGE_COOKIE_NAME}=${token}` },
    }), secret, nowMs)).not.toThrow();
  });
});
