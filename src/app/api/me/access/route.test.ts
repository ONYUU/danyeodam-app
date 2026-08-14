import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyAdultAccessToken,
  getAccessProjection,
  logSafeServerError,
} = vi.hoisted(() => ({
  verifyAdultAccessToken: vi.fn(),
  getAccessProjection: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/auth/verify-adult-access-token", () => ({ verifyAdultAccessToken }));
vi.mock("@/server/access/repository", () => ({ getAccessProjection }));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));

import { GET } from "@/app/api/me/access/route";

function accessRequest(token = "test-access-token"): Request {
  return new Request("https://api.example.test/api/me/access", {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("GET /api/me/access", () => {
  beforeEach(() => {
    verifyAdultAccessToken.mockReset();
    getAccessProjection.mockReset();
    logSafeServerError.mockReset();
  });

  it("returns only the safe reviewer projection after both identity checks", async () => {
    verifyAdultAccessToken.mockResolvedValue("11111111-1111-4111-8111-111111111111");
    getAccessProjection.mockResolvedValue({
      status: "ready",
      participant: true,
      access_type: "store_reviewer",
      field_acquisition_requires_location: true,
      fixture_version: "store-2026.08.1",
    });

    const response = await GET(accessRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
    await expect(response.json()).resolves.toEqual({
      participant: true,
      access_type: "store_reviewer",
      field_acquisition_requires_location: true,
      fixture_version: "store-2026.08.1",
    });
    expect(verifyAdultAccessToken).toHaveBeenCalledWith("test-access-token");
    expect(getAccessProjection).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("returns 401 when the DB recheck reports a revoked binding", async () => {
    verifyAdultAccessToken.mockResolvedValue("11111111-1111-4111-8111-111111111111");
    getAccessProjection.mockResolvedValue({ status: "unauthorized" });

    const response = await GET(accessRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("fails closed without logging credentials or membership data", async () => {
    verifyAdultAccessToken.mockResolvedValue("11111111-1111-4111-8111-111111111111");
    getAccessProjection.mockRejectedValue(new Error("database unavailable"));

    const response = await GET(accessRequest("private-token-value"));

    expect(response.status).toBe(500);
    expect(logSafeServerError).toHaveBeenCalledWith({
      requestId: expect.any(String),
      operation: "access_projection",
      category: "unexpected",
    });
    expect(JSON.stringify(logSafeServerError.mock.calls)).not.toContain("private-token-value");
    expect(JSON.stringify(logSafeServerError.mock.calls)).not.toContain(
      "11111111-1111-4111-8111-111111111111",
    );
  });
});
