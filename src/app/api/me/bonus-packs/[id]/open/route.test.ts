import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyAdultAccessToken,
  openBonusPack,
  logSafeServerError,
} = vi.hoisted(() => ({
  verifyAdultAccessToken: vi.fn(),
  openBonusPack: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/auth/verify-adult-access-token", () => ({ verifyAdultAccessToken }));
vi.mock("@/server/bonus-packs/service", () => ({ openBonusPack }));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));

import { POST } from "@/app/api/me/bonus-packs/[id]/open/route";

const authUserId = "11111111-1111-4111-8111-111111111111";
const bonusPackId = "22222222-2222-4222-8222-222222222222";
const clientRequestId = "abcdefab-cdef-4abc-8abc-abcdefabcdef";

function request(body: Record<string, unknown>, token = "private-access-token"): Request {
  return new Request(`https://api.example.test/api/me/bonus-packs/${bonusPackId}/open`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function context(id = bonusPackId) {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/me/bonus-packs/[id]/open", () => {
  beforeEach(() => {
    verifyAdultAccessToken.mockResolvedValue(authUserId);
    openBonusPack.mockResolvedValue({
      bonus_pack: {
        id: bonusPackId,
        status: "opened",
        issued_at: "2026-08-15T00:00:00.000Z",
        date_kst: "2026-08-15",
        opened_at: "2026-08-15T00:01:00.000Z",
        card: { id: "33333333-3333-4333-8333-333333333333", rarity: "common" },
      },
    });
  });

  it("accepts only the idempotency UUID and never a client-selected result", async () => {
    const response = await POST(
      request({ client_request_id: clientRequestId }),
      context(),
    );
    expect(response.status).toBe(200);
    expect(openBonusPack).toHaveBeenCalledWith({
      authUserId,
      bonusPackId,
      clientRequestId,
    });
  });

  it.each([
    { client_request_id: clientRequestId, rarity: "special" },
    { client_request_id: clientRequestId, card_id: "33333333-3333-4333-8333-333333333333" },
    { client_request_id: "not-a-uuid" },
  ])("rejects expanded or malformed result-selection input: %j", async (body) => {
    const response = await POST(request(body), context());
    expect(response.status).toBe(400);
    expect(openBonusPack).not.toHaveBeenCalled();
  });

  it("maps a malformed resource path to 404 before reading the domain input", async () => {
    const response = await POST(
      request({ client_request_id: clientRequestId }),
      context("not-an-id"),
    );
    expect(response.status).toBe(404);
    expect(openBonusPack).not.toHaveBeenCalled();
  });

  it("logs only a fixed operation marker on unexpected failures", async () => {
    openBonusPack.mockRejectedValue(new Error("database detail"));
    const response = await POST(
      request({ client_request_id: clientRequestId }, "secret-bearer"),
      context(),
    );
    expect(response.status).toBe(500);
    expect(logSafeServerError).toHaveBeenCalledWith({
      requestId: expect.any(String),
      operation: "open_bonus_pack",
      category: "unexpected",
    });
    const logged = JSON.stringify(logSafeServerError.mock.calls);
    expect(logged).not.toContain("secret-bearer");
    expect(logged).not.toContain(clientRequestId);
    expect(logged).not.toContain(bonusPackId);
  });
});
