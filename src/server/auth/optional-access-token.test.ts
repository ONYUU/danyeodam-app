import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifyAccessToken } = vi.hoisted(() => ({ verifyAccessToken: vi.fn() }));

vi.mock("@/server/auth/verify-access-token", () => ({ verifyAccessToken }));

import { verifyOptionalAccessToken } from "@/server/auth/optional-access-token";

describe("verifyOptionalAccessToken", () => {
  beforeEach(() => verifyAccessToken.mockReset());

  it("allows a request that omits Authorization", async () => {
    await expect(verifyOptionalAccessToken(new Request("https://example.test")))
      .resolves.toBeNull();
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it("verifies a provided bearer token", async () => {
    verifyAccessToken.mockResolvedValue("11111111-1111-4111-8111-111111111111");
    const request = new Request("https://example.test", {
      headers: { Authorization: "Bearer valid.jwt.token" },
    });
    await expect(verifyOptionalAccessToken(request))
      .resolves.toBe("11111111-1111-4111-8111-111111111111");
    expect(verifyAccessToken).toHaveBeenCalledWith("valid.jwt.token");
  });

  it("rejects a malformed Authorization header instead of treating it as public", async () => {
    const request = new Request("https://example.test", {
      headers: { Authorization: "Basic secret" },
    });
    await expect(verifyOptionalAccessToken(request)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      status: 401,
    });
  });
});
