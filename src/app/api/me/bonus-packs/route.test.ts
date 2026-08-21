import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyAdultAccessToken,
  listBonusPacks,
  getServerEnvironment,
  logSafeServerError,
} = vi.hoisted(() => ({
  verifyAdultAccessToken: vi.fn(),
  listBonusPacks: vi.fn(),
  getServerEnvironment: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/auth/verify-adult-access-token", () => ({ verifyAdultAccessToken }));
vi.mock("@/server/bonus-packs/service", () => ({ listBonusPacks }));
vi.mock("@/server/env", () => ({ getServerEnvironment }));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));

import { GET } from "@/app/api/me/bonus-packs/route";

const authUserId = "11111111-1111-4111-8111-111111111111";
const cursorSecret = "test-only-bonus-pack-cursor-secret-0001";

function request(query = ""): Request {
  return new Request(`https://api.example.test/api/me/bonus-packs${query}`, {
    headers: { authorization: "Bearer private-access-token" },
  });
}

describe("GET /api/me/bonus-packs", () => {
  beforeEach(() => {
    verifyAdultAccessToken.mockResolvedValue(authUserId);
    getServerEnvironment.mockReturnValue({ BONUS_PACK_CURSOR_SECRET: cursorSecret });
    listBonusPacks.mockResolvedValue({
      items: [],
      sealed_count: 87,
      page: { next_cursor: null, has_more: false },
    });
  });

  it("passes only validated pagination and the server secret", async () => {
    const response = await GET(request("?limit=10&cursor=opaque"));
    expect(response.status).toBe(200);
    expect(listBonusPacks).toHaveBeenCalledWith({
      authUserId,
      limit: 10,
      cursor: "opaque",
      cursorSecret,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ sealed_count: 87 });
  });

  it("rejects an expanded query before the repository service", async () => {
    const response = await GET(request("?rarity=special"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });
    expect(listBonusPacks).not.toHaveBeenCalled();
  });

  it("fails closed without a cursor secret and logs no request data", async () => {
    getServerEnvironment.mockReturnValue({ BONUS_PACK_CURSOR_SECRET: undefined });
    const response = await GET(request("?cursor=private-cursor"));
    expect(response.status).toBe(500);
    expect(logSafeServerError).toHaveBeenCalledWith({
      requestId: expect.any(String),
      operation: "list_bonus_packs",
      category: "unexpected",
    });
    const logged = JSON.stringify(logSafeServerError.mock.calls);
    expect(logged).not.toContain("private-access-token");
    expect(logged).not.toContain("private-cursor");
  });
});
