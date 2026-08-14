import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/server/http/api-error";

const {
  verifyAccessToken,
  retryAccountDeletionJobAdmin,
  logSafeServerError,
} = vi.hoisted(() => ({
  verifyAccessToken: vi.fn(),
  retryAccountDeletionJobAdmin: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/auth/verify-access-token", () => ({ verifyAccessToken }));
vi.mock("@/server/account-deletion/repository", () => ({
  retryAccountDeletionJobAdmin,
}));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));

import { POST } from "@/app/api/admin/account-deletions/[id]/retry/route";

const deletionId = "22222222-2222-4222-8222-222222222222";
const clientActionId = "33333333-3333-4333-8333-333333333333";

function request(body: unknown = {
  action: "retry",
  client_action_id: clientActionId,
  reason_code: "WORKER_STALLED",
  note: "Worker lease reviewed",
}): Request {
  return new Request(
    `https://api.example.test/api/admin/account-deletions/${deletionId}/retry`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer admin-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

function context(id = deletionId): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/admin/account-deletions/:id/retry", () => {
  beforeEach(() => {
    verifyAccessToken.mockReset();
    retryAccountDeletionJobAdmin.mockReset();
    logSafeServerError.mockReset();
    verifyAccessToken.mockResolvedValue("11111111-1111-4111-8111-111111111111");
    retryAccountDeletionJobAdmin.mockResolvedValue({
      status: "retry_scheduled",
      id: deletionId,
      next_attempt_at: "2026-08-12T02:00:00.000Z",
    });
  });

  it("schedules the opaque request for immediate retry", async () => {
    const response = await POST(request(), context());
    expect(response.status).toBe(202);
    expect(retryAccountDeletionJobAdmin).toHaveBeenCalledWith({
      adminAuthUserId: "11111111-1111-4111-8111-111111111111",
      requestId: deletionId,
      clientActionId,
      reasonCode: "WORKER_STALLED",
      note: "Worker lease reviewed",
    });
    await expect(response.json()).resolves.toEqual({
      retry: {
        status: "retry_scheduled",
        id: deletionId,
        next_attempt_at: "2026-08-12T02:00:00.000Z",
      },
    });
  });

  it("returns an idempotent completed result", async () => {
    retryAccountDeletionJobAdmin.mockResolvedValue({
      status: "completed",
      id: deletionId,
    });
    const response = await POST(request(), context());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      retry: { status: "completed", id: deletionId },
    });
  });

  it("returns an exact client-action replay as duplicate", async () => {
    retryAccountDeletionJobAdmin.mockResolvedValue({
      status: "duplicate",
      id: deletionId,
      original_status: "retry_scheduled",
      next_attempt_at: "2026-08-12T02:00:00.000Z",
    });
    const response = await POST(request(), context());
    expect(response.status).toBe(200);
    expect((await response.json()).retry.status).toBe("duplicate");
  });

  it("maps a mismatched client-action replay to idempotency conflict", async () => {
    retryAccountDeletionJobAdmin.mockRejectedValue(
      new ApiError("IDEMPOTENCY_CONFLICT"),
    );
    const response = await POST(request(), context());
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("returns the bounded administrator retry limit", async () => {
    retryAccountDeletionJobAdmin.mockRejectedValue(
      new ApiError("RATE_LIMITED", { retry_after_seconds: 27 }),
    );
    const response = await POST(request(), context());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("27");
    expect((await response.json()).error.code).toBe("RATE_LIMITED");
  });

  it("returns the safe not-found response from the repository", async () => {
    retryAccountDeletionJobAdmin.mockRejectedValue(new ApiError("NOT_FOUND"));
    const response = await POST(request(), context());
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  it("rejects malformed IDs before calling the retry RPC", async () => {
    const response = await POST(request(), context("not-a-uuid"));
    expect(response.status).toBe(404);
    expect(retryAccountDeletionJobAdmin).not.toHaveBeenCalled();
  });

  it("rejects retry bodies with extra identifying fields", async () => {
    const response = await POST(request({
      action: "retry",
      client_action_id: clientActionId,
      reason_code: "WORKER_STALLED",
      note: "Worker lease reviewed",
      user_id: "secret",
    }), context());
    expect(response.status).toBe(400);
    expect(retryAccountDeletionJobAdmin).not.toHaveBeenCalled();
  });
});
