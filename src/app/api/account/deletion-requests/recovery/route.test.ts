import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  consumeAccountDeletionPublicRateLimit,
  requestAccountDeletionByRecovery,
  getServerEnvironment,
  logSafeServerError,
} = vi.hoisted(() => ({
  consumeAccountDeletionPublicRateLimit: vi.fn(),
  requestAccountDeletionByRecovery: vi.fn(),
  getServerEnvironment: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/account-deletion/repository", () => ({
  consumeAccountDeletionPublicRateLimit,
  requestAccountDeletionByRecovery,
}));
vi.mock("@/server/env", () => ({ getServerEnvironment }));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));

import { POST } from "@/app/api/account/deletion-requests/recovery/route";

const deletionId = "11111111-1111-4111-8111-111111111111";
const recoveryCode = Buffer.alloc(32, 0x52).toString("base64url");
const statusToken = Buffer.alloc(32, 0x53).toString("base64url");

function recoveryRequest(code = recoveryCode): Request {
  return new Request(
    "https://api.example.test/api/account/deletion-requests/recovery",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.10",
      },
      body: JSON.stringify({
        recovery_code: code,
        client_request_id: deletionId,
        status_token: statusToken,
        confirmation: "DELETE_MY_ACCOUNT",
      }),
    },
  );
}

describe("POST /api/account/deletion-requests/recovery", () => {
  beforeEach(() => {
    consumeAccountDeletionPublicRateLimit.mockReset();
    requestAccountDeletionByRecovery.mockReset();
    getServerEnvironment.mockReset();
    logSafeServerError.mockReset();
    getServerEnvironment.mockReturnValue({
      ACCOUNT_DELETION_RATE_LIMIT_SECRET: "s".repeat(32),
    });
    consumeAccountDeletionPublicRateLimit.mockResolvedValue({
      status: "allowed",
      retry_after_seconds: 3600,
    });
  });

  it("starts deletion without first claiming the anonymous account", async () => {
    requestAccountDeletionByRecovery.mockResolvedValue({
      status: "accepted",
      deletion_request: {
        id: deletionId,
        status: "pending",
        requested_at: "2026-08-12T00:00:00.000Z",
        complete_by: "2026-08-13T00:00:00.000Z",
      },
    });

    const response = await POST(recoveryRequest());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      deletion_request: { id: deletionId, status: "pending" },
    });
    expect(requestAccountDeletionByRecovery).toHaveBeenCalledWith({
      recoveryCodeHashHex: expect.stringMatching(/^[a-f0-9]{64}$/u),
      requestId: deletionId,
      statusTokenHashHex: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const serializedCalls = JSON.stringify(requestAccountDeletionByRecovery.mock.calls);
    expect(serializedCalls).not.toContain(recoveryCode);
    expect(serializedCalls).not.toContain(statusToken);
  });

  it("returns 404 without exposing whether the recovery subject exists", async () => {
    requestAccountDeletionByRecovery.mockResolvedValue({ status: "not_found" });

    const response = await POST(recoveryRequest());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });

  it("enforces the public IP limiter before parsing or hashing a recovery code", async () => {
    consumeAccountDeletionPublicRateLimit.mockResolvedValue({
      status: "rate_limited",
      retry_after_seconds: 123,
    });

    const response = await POST(recoveryRequest("malformed-secret"));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("123");
    expect(requestAccountDeletionByRecovery).not.toHaveBeenCalled();
    expect(JSON.stringify(logSafeServerError.mock.calls)).not.toContain("malformed-secret");
  });
});
