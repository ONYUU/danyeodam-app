import { describe, expect, it } from "vitest";

import { parseClaimRecoveryInput } from "@/server/recovery/input";

describe("recovery claim input", () => {
  it("accepts only the issued code shape", () => {
    const code = "A".repeat(43);
    expect(parseClaimRecoveryInput({ code })).toEqual({ code });
  });

  it.each(["short", `${"A".repeat(42)}!`, `${"A".repeat(44)}`])(
    "rejects malformed codes before hashing",
    (code) => {
      expect(() => parseClaimRecoveryInput({ code })).toThrowError(
        expect.objectContaining({ code: "VALIDATION_FAILED" }),
      );
    },
  );
});
