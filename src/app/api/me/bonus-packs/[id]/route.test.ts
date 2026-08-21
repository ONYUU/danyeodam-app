import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyAdultAccessToken,
  getBonusPack,
  logSafeServerError,
} = vi.hoisted(() => ({
  verifyAdultAccessToken: vi.fn(),
  getBonusPack: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/auth/verify-adult-access-token", () => ({ verifyAdultAccessToken }));
vi.mock("@/server/bonus-packs/service", () => ({ getBonusPack }));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));

import { GET } from "@/app/api/me/bonus-packs/[id]/route";

const authUserId = "11111111-1111-4111-8111-111111111111";
const bonusPackId = "22222222-2222-4222-8222-222222222222";

function request(query = ""): Request {
  return new Request(`https://api.example.test/api/me/bonus-packs/${bonusPackId}${query}`, {
    headers: { authorization: "Bearer private-access-token" },
  });
}

function context(id = bonusPackId) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/me/bonus-packs/[id]", () => {
  beforeEach(() => {
    verifyAdultAccessToken.mockResolvedValue(authUserId);
    getBonusPack.mockResolvedValue({
      bonus_pack: {
        id: bonusPackId,
        status: "sealed",
        issued_at: "2026-08-15T00:00:00.000Z",
        date_kst: "2026-08-15",
      },
    });
  });

  it("looks up only the authenticated user's validated pack ID", async () => {
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    expect(getBonusPack).toHaveBeenCalledWith({ authUserId, bonusPackId });
  });

  it("rejects query expansion and malformed IDs before the service", async () => {
    expect((await GET(request("?result=true"), context())).status).toBe(400);
    expect((await GET(request(), context("not-an-id"))).status).toBe(404);
    expect(getBonusPack).not.toHaveBeenCalled();
  });

  it("logs only a fixed operation marker on an unexpected service failure", async () => {
    getBonusPack.mockRejectedValue(new Error("private database detail"));
    const response = await GET(request(), context());
    expect(response.status).toBe(500);
    expect(logSafeServerError).toHaveBeenCalledWith({
      requestId: expect.any(String),
      operation: "get_bonus_pack",
      category: "unexpected",
    });
    const logged = JSON.stringify(logSafeServerError.mock.calls);
    expect(logged).not.toContain(bonusPackId);
    expect(logged).not.toContain("private-access-token");
  });
});
