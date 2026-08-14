import { describe, expect, it } from "vitest";

import { createInviteCode, hashInviteCode } from "@/server/participants/code";

describe("participant invite codes", () => {
  it("creates 128-bit base64url codes", () => {
    const code = createInviteCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("hashes deterministically without retaining plaintext", () => {
    const hash = hashInviteCode("AAAAAAAAAAAAAAAAAAAAAA");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe(hashInviteCode("AAAAAAAAAAAAAAAAAAAAAA"));
    expect(hash).not.toContain("AAAAAAAA");
  });
});
