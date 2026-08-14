import { describe, expect, it } from "vitest";

import { parseAcquireInput } from "@/server/acquire/input";

const validInput = {
  spot_id: "00000000-0000-4000-8000-000000000101",
  lat: 37.5665,
  lng: 126.978,
  accuracy: 25,
  idempotency_key: "00000000-0000-4000-8000-000000000201",
};

describe("parseAcquireInput", () => {
  it("accepts a bounded acquisition payload", () => {
    expect(parseAcquireInput(validInput)).toEqual(validInput);
  });

  it.each([
    { ...validInput, lat: Number.NaN },
    { ...validInput, lng: Number.POSITIVE_INFINITY },
    { ...validInput, lat: 91 },
    { ...validInput, lng: -181 },
    { ...validInput, accuracy: -1 },
    { ...validInput, accuracy: 50_001 },
    { ...validInput, spot_id: "not-a-uuid" },
    { ...validInput, idempotency_key: "not-a-uuid" },
    { ...validInput, unexpected: true },
  ])("rejects an invalid or expanded payload", (value) => {
    expect(() => parseAcquireInput(value)).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });
});
