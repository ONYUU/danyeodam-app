import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyAdultAccessToken,
  listCardInventory,
  getServerEnvironment,
  logSafeServerError,
} = vi.hoisted(() => ({
  verifyAdultAccessToken: vi.fn(),
  listCardInventory: vi.fn(),
  getServerEnvironment: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/auth/verify-adult-access-token", () => ({ verifyAdultAccessToken }));
vi.mock("@/server/bonus-packs/service", () => ({ listCardInventory }));
vi.mock("@/server/env", () => ({ getServerEnvironment }));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));

import { GET } from "@/app/api/me/card-inventory/route";

const authUserId = "11111111-1111-4111-8111-111111111111";
const cursorSecret = "test-only-bonus-pack-cursor-secret-0001";

function request(query = ""): Request {
  return new Request(`https://api.example.test/api/me/card-inventory${query}`, {
    headers: { authorization: "Bearer private-access-token" },
  });
}

describe("GET /api/me/card-inventory", () => {
  beforeEach(() => {
    verifyAdultAccessToken.mockResolvedValue(authUserId);
    getServerEnvironment.mockReturnValue({ BONUS_PACK_CURSOR_SECRET: cursorSecret });
    listCardInventory.mockResolvedValue({
      items: [],
      page: { next_cursor: null, has_more: false },
    });
  });

  it("passes only validated pagination and the server-only cursor secret", async () => {
    const response = await GET(request("?limit=25&cursor=opaque"));
    expect(response.status).toBe(200);
    expect(listCardInventory).toHaveBeenCalledWith({
      authUserId,
      limit: 25,
      cursor: "opaque",
      cursorSecret,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects result-selection query expansion", async () => {
    const response = await GET(request("?rarity=special"));
    expect(response.status).toBe(400);
    expect(listCardInventory).not.toHaveBeenCalled();
  });

  it("fails closed and logs no cursor when the signing secret is unavailable", async () => {
    getServerEnvironment.mockReturnValue({ BONUS_PACK_CURSOR_SECRET: undefined });
    const response = await GET(request("?cursor=private-cursor"));
    expect(response.status).toBe(500);
    expect(logSafeServerError).toHaveBeenCalledWith({
      requestId: expect.any(String),
      operation: "list_card_inventory",
      category: "unexpected",
    });
    expect(JSON.stringify(logSafeServerError.mock.calls)).not.toContain("private-cursor");
  });
});
