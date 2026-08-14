import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  deletePersonalCard,
  logSafeServerError,
  verifyActiveIdentityAccessToken,
} = vi.hoisted(() => ({
  deletePersonalCard: vi.fn(),
  logSafeServerError: vi.fn(),
  verifyActiveIdentityAccessToken: vi.fn(),
}));

vi.mock("@/server/auth/verify-active-identity-access-token", () => ({
  verifyActiveIdentityAccessToken,
}));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));
vi.mock("@/server/personal-cards/service", () => ({ deletePersonalCard }));

import { DELETE } from "@/app/api/personal-cards/[id]/route";
import { ApiError } from "@/server/http/api-error";

const authUserId = "11111111-1111-4111-8111-111111111111";
const personalCardId = "22222222-2222-4222-8222-222222222222";
const clientRequestId = "33333333-3333-4333-8333-333333333333";

function request(body: unknown = { client_request_id: clientRequestId }): Request {
  return new Request(`https://api.example.test/api/personal-cards/${personalCardId}`, {
    method: "DELETE",
    headers: {
      authorization: "Bearer active-access-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const context = (id = personalCardId) => ({ params: Promise.resolve({ id }) });

describe("DELETE /api/personal-cards/:id", () => {
  beforeEach(() => {
    deletePersonalCard.mockReset();
    logSafeServerError.mockReset();
    verifyActiveIdentityAccessToken.mockReset();
    verifyActiveIdentityAccessToken.mockResolvedValue(authUserId);
    deletePersonalCard.mockResolvedValue({ status: "accepted" });
  });

  it("returns the exact 202 accepted contract", async () => {
    const response = await DELETE(request(), context());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: "accepted" });
    expect(deletePersonalCard).toHaveBeenCalledWith({
      authUserId,
      personalCardId,
      clientRequestId,
    });
  });

  it("uses active identity auth so deletion is not blocked by age policy", async () => {
    await DELETE(request(), context());
    expect(verifyActiveIdentityAccessToken).toHaveBeenCalledWith("active-access-token");
  });

  it("maps malformed ids and strict request bodies before mutation", async () => {
    const badId = await DELETE(request(), context("not-a-uuid"));
    expect(badId.status).toBe(404);

    const badBody = await DELETE(request({ client_request_id: clientRequestId, extra: true }), context());
    expect(badBody.status).toBe(400);
    expect(deletePersonalCard).not.toHaveBeenCalled();
  });

  it("preserves the no-existence-leak 404 result", async () => {
    deletePersonalCard.mockRejectedValue(new ApiError("NOT_FOUND"));
    const response = await DELETE(request(), context());
    expect(response.status).toBe(404);
  });

  it("returns 409 when a request key is reused for another card", async () => {
    deletePersonalCard.mockRejectedValue(new ApiError("IDEMPOTENCY_CONFLICT"));
    const response = await DELETE(request(), context());
    expect(response.status).toBe(409);
  });

  it("logs no card or request identifier on an unexpected failure", async () => {
    deletePersonalCard.mockRejectedValue(new Error("database unavailable"));
    const response = await DELETE(request(), context());
    expect(response.status).toBe(500);
    expect(logSafeServerError).toHaveBeenCalledWith(expect.objectContaining({
      operation: "personal_card_delete",
      category: "unexpected",
    }));
    const log = JSON.stringify(logSafeServerError.mock.calls);
    expect(log).not.toContain(personalCardId);
    expect(log).not.toContain(clientRequestId);
  });
});
