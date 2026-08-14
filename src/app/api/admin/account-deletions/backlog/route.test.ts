import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyAccessToken,
  getAccountDeletionBacklogAdmin,
  logSafeServerError,
} = vi.hoisted(() => ({
  verifyAccessToken: vi.fn(),
  getAccountDeletionBacklogAdmin: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/auth/verify-access-token", () => ({ verifyAccessToken }));
vi.mock("@/server/account-deletion/repository", () => ({
  getAccountDeletionBacklogAdmin,
}));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));

import { GET } from "@/app/api/admin/account-deletions/backlog/route";

describe("GET /api/admin/account-deletions/backlog", () => {
  beforeEach(() => {
    verifyAccessToken.mockReset();
    getAccountDeletionBacklogAdmin.mockReset();
    logSafeServerError.mockReset();
    verifyAccessToken.mockResolvedValue("11111111-1111-4111-8111-111111111111");
    getAccountDeletionBacklogAdmin.mockResolvedValue({
      status: "ready",
      pending_jobs: 3,
      overdue_jobs: 1,
      high_attempt_jobs: 1,
      max_attempt_count: 12,
      oldest_requested_at: "2026-08-12T00:00:00.000Z",
      retrying_jobs: 2,
      completed_receipts: 4,
    });
  });

  it("returns only aggregate operational counts", async () => {
    const response = await GET(new Request(
      "https://api.example.test/api/admin/account-deletions/backlog",
      { headers: { authorization: "Bearer admin-token" } },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      backlog: {
        pending_jobs: 3,
        overdue_jobs: 1,
        high_attempt_jobs: 1,
        max_attempt_count: 12,
        oldest_requested_at: "2026-08-12T00:00:00.000Z",
        retrying_jobs: 2,
        completed_receipts: 4,
      },
    });
  });

  it("rejects unexpected query parameters", async () => {
    const response = await GET(new Request(
      "https://api.example.test/api/admin/account-deletions/backlog?user_id=secret",
      { headers: { authorization: "Bearer admin-token" } },
    ));
    expect(response.status).toBe(400);
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });
});
