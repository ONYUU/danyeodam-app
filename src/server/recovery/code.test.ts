import { describe, expect, it } from "vitest";

import { createRecoveryCode, hashRecoveryCode } from "@/server/recovery/code";

describe("recovery codes", () => {
  it("creates 256-bit base64url codes", () => {
    expect(createRecoveryCode()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("produces a fixed 32-byte digest", () => {
    const code = "A".repeat(43);
    expect(hashRecoveryCode(code)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashRecoveryCode(code)).toBe(hashRecoveryCode(code));
  });
});
