import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  consumeAccountDeletionPublicRateLimit,
  getAccountDeletionStatusCandidate,
  getServerEnvironment,
  logSafeServerError,
} = vi.hoisted(() => ({
  consumeAccountDeletionPublicRateLimit: vi.fn(),
  getAccountDeletionStatusCandidate: vi.fn(),
  getServerEnvironment: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/account-deletion/repository", () => ({
  consumeAccountDeletionPublicRateLimit,
  getAccountDeletionStatusCandidate,
}));
vi.mock("@/server/env", () => ({ getServerEnvironment }));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));

import { GET } from "@/app/api/account/deletion-requests/[id]/route";

const deletionId = "11111111-1111-4111-8111-111111111111";
const token = "A".repeat(43);

function statusRequest(statusToken = token): Request {
  return new Request(
    `https://api.example.test/api/account/deletion-requests/${deletionId}`,
    {
      headers: {
        "x-deletion-status-token": statusToken,
        "x-forwarded-for": "203.0.113.10",
      },
    },
  );
}

const context = { params: Promise.resolve({ id: deletionId }) };

describe("GET /api/account/deletion-requests/:id", () => {
  beforeEach(() => {
    consumeAccountDeletionPublicRateLimit.mockReset();
    getAccountDeletionStatusCandidate.mockReset();
    getServerEnvironment.mockReset();
    logSafeServerError.mockReset();
    getServerEnvironment.mockReturnValue({
      PUBLIC_APP_URL: "https://danyeodam.example",
      ACCOUNT_DELETION_RATE_LIMIT_SECRET: "s".repeat(32),
    });
    consumeAccountDeletionPublicRateLimit.mockResolvedValue({
      status: "allowed",
      retry_after_seconds: 60,
    });
  });

  it("returns the safe public state after constant-length digest verification", async () => {
    getAccountDeletionStatusCandidate.mockResolvedValue({
      status: "found",
      status_token_hash: createHash("sha256").update(token).digest("hex"),
      id: deletionId,
      public_status: "pending",
      reason_code: "retrying",
      requested_at: "2026-08-12T00:00:00.000Z",
      complete_by: "2026-08-13T00:00:00.000Z",
      completed_at: null,
    });

    const response = await GET(statusRequest(), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: deletionId,
      status: "pending",
      reason_code: "retrying",
      requested_at: "2026-08-12T00:00:00.000Z",
      complete_by: "2026-08-13T00:00:00.000Z",
      completed_at: null,
      support_url: null,
    });
  });

  it("projects an overdue request to action_required with the configured support URL", async () => {
    getServerEnvironment.mockReturnValue({
      PUBLIC_APP_URL: "https://danyeodam.example",
      ACCOUNT_DELETION_RATE_LIMIT_SECRET: "s".repeat(32),
      ACCOUNT_DELETION_SUPPORT_URL: "https://support.example/delete",
    });
    getAccountDeletionStatusCandidate.mockResolvedValue({
      status: "found",
      status_token_hash: createHash("sha256").update(token).digest("hex"),
      id: deletionId,
      public_status: "pending",
      reason_code: "overdue",
      requested_at: "2026-08-12T00:00:00.000Z",
      complete_by: "2026-08-13T00:00:00.000Z",
      completed_at: null,
    });

    const response = await GET(statusRequest(), context);

    await expect(response.json()).resolves.toMatchObject({
      status: "action_required",
      reason_code: "manual_support_required",
      support_url: "https://support.example/delete",
    });
  });

  it("uses the same 404 for a missing request and a wrong bearer token", async () => {
    getAccountDeletionStatusCandidate.mockResolvedValue({
      status: "found",
      status_token_hash: createHash("sha256").update(token).digest("hex"),
      id: deletionId,
      public_status: "pending",
      reason_code: null,
      requested_at: "2026-08-12T00:00:00.000Z",
      complete_by: "2026-08-13T00:00:00.000Z",
      completed_at: null,
    });

    const response = await GET(
      statusRequest(Buffer.alloc(32, 0x42).toString("base64url")),
      context,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });

  it("enforces the public IP limit before reading the status candidate", async () => {
    consumeAccountDeletionPublicRateLimit.mockResolvedValue({
      status: "rate_limited",
      retry_after_seconds: 37,
    });

    const response = await GET(statusRequest(), context);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("37");
    expect(getAccountDeletionStatusCandidate).not.toHaveBeenCalled();
    expect(JSON.stringify(logSafeServerError.mock.calls)).not.toContain(token);
  });
});
