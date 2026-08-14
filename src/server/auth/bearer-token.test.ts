import { describe, expect, it } from "vitest";

import { requireBearerToken } from "@/server/auth/bearer-token";

describe("requireBearerToken", () => {
  it("returns a well-formed bearer token", () => {
    const request = new Request("https://example.test/api/acquire", {
      headers: { Authorization: "Bearer header.payload.signature" },
    });
    expect(requireBearerToken(request)).toBe("header.payload.signature");
  });

  it.each([undefined, "Basic abc", "bearer abc", "Bearer ", "Bearer abc value"])(
    "rejects a missing or malformed authorization header",
    (authorization) => {
      const headers = authorization === undefined ? undefined : { Authorization: authorization };
      const request = new Request("https://example.test/api/acquire", { headers });
      expect(() => requireBearerToken(request)).toThrowError(
        expect.objectContaining({ code: "UNAUTHORIZED" }),
      );
    },
  );
});
