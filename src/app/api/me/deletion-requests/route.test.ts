import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifySupabaseAccessTokenUser,
  requestAccountDeletion,
  logSafeServerError,
} = vi.hoisted(() => ({
  verifySupabaseAccessTokenUser: vi.fn(),
  requestAccountDeletion: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/auth/verify-access-token", () => ({
  verifySupabaseAccessTokenUser,
}));
vi.mock("@/server/account-deletion/repository", () => ({
  requestAccountDeletion,
}));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));

import { POST } from "@/app/api/me/deletion-requests/route";

const userId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const token = "A".repeat(43);

function deletionRequest(statusToken = token): Request {
  return new Request("https://api.example.test/api/me/deletion-requests", {
    method: "POST",
    headers: {
      authorization: "Bearer private-access-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_request_id: requestId,
      status_token: statusToken,
      confirmation: "DELETE_MY_ACCOUNT",
    }),
  });
}

describe("POST /api/me/deletion-requests", () => {
  beforeEach(() => {
    verifySupabaseAccessTokenUser.mockReset();
    requestAccountDeletion.mockReset();
    logSafeServerError.mockReset();
  });

  it("accepts a deletion retry using valid Auth even after the service binding was revoked", async () => {
    verifySupabaseAccessTokenUser.mockResolvedValue({ id: userId, isAnonymous: true });
    requestAccountDeletion.mockResolvedValue({
      status: "accepted",
      deletion_request: {
        id: requestId,
        status: "pending",
        requested_at: "2026-08-12T00:00:00.000Z",
        complete_by: "2026-08-13T00:00:00.000Z",
      },
    });

    const response = await POST(deletionRequest());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      deletion_request: { id: requestId, status: "pending" },
    });
    expect(verifySupabaseAccessTokenUser).toHaveBeenCalledWith("private-access-token");
    expect(requestAccountDeletion).toHaveBeenCalledWith({
      authUserId: userId,
      requestId,
      statusTokenHashHex: createHash("sha256").update(token).digest("hex"),
    });
  });

  it("returns a stable conflict without logging the status token", async () => {
    verifySupabaseAccessTokenUser.mockResolvedValue({ id: userId, isAnonymous: true });
    requestAccountDeletion.mockResolvedValue({ status: "idempotency_conflict" });

    const response = await POST(deletionRequest());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });
    expect(JSON.stringify(logSafeServerError.mock.calls)).not.toContain(token);
  });

  it("logs only fixed metadata when deletion persistence fails", async () => {
    verifySupabaseAccessTokenUser.mockResolvedValue({ id: userId, isAnonymous: true });
    requestAccountDeletion.mockRejectedValue(new Error(`leaked-${token}`));

    const response = await POST(deletionRequest());

    expect(response.status).toBe(500);
    expect(logSafeServerError).toHaveBeenCalledWith({
      requestId: expect.any(String),
      operation: "account_deletion_request",
      category: "unexpected",
    });
    const logged = JSON.stringify(logSafeServerError.mock.calls);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(userId);
  });
});
