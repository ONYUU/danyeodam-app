import { describe, expect, it } from "vitest";

import { parsePhysicalRequestInput } from "@/server/physical-requests/input";

describe("physical request input", () => {
  it.each(["request", "notify"] as const)("accepts %s", (kind) => {
    expect(parsePhysicalRequestInput({ kind })).toEqual({ kind });
  });

  it("rejects payment and arbitrary values", () => {
    expect(() => parsePhysicalRequestInput({ kind: "purchase" })).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
    expect(() => parsePhysicalRequestInput({ kind: "request", price: 10_000 })).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });
});
