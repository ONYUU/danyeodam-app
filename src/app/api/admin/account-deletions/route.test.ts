import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyAccessToken,
  listAccountDeletionJobsAdmin,
  logSafeServerError,
} = vi.hoisted(() => ({
  verifyAccessToken: vi.fn(),
  listAccountDeletionJobsAdmin: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/auth/verify-access-token", () => ({ verifyAccessToken }));
vi.mock("@/server/account-deletion/repository", () => ({
  listAccountDeletionJobsAdmin,
}));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));

import { GET } from "@/app/api/admin/account-deletions/route";

describe("GET /api/admin/account-deletions", () => {
  beforeEach(() => {
    verifyAccessToken.mockReset();
    listAccountDeletionJobsAdmin.mockReset();
    logSafeServerError.mockReset();
    verifyAccessToken.mockResolvedValue("11111111-1111-4111-8111-111111111111");
    listAccountDeletionJobsAdmin.mockResolvedValue([{
      id: "22222222-2222-4222-8222-222222222222",
      status: "pending",
      phase: "storage_final",
      last_error_code: "STORAGE_DELETE_FAILED",
      last_error_at: "2026-08-12T01:00:00.000Z",
      attempt_count: 3,
      consecutive_failure_count: 2,
      requested_at: "2026-08-12T00:00:00.000Z",
      complete_by: "2026-08-13T00:00:00.000Z",
      next_attempt_at: "2026-08-12T01:05:00.000Z",
      lease_state: "none",
      lease_expires_at: null,
      database_deleted_at: null,
      completed_at: null,
      updated_at: "2026-08-12T01:00:00.000Z",
    }]);
  });

  it("returns only bounded operational deletion fields", async () => {
    const response = await GET(new Request(
      "https://api.example.test/api/admin/account-deletions?status=active&limit=25",
      { headers: { authorization: "Bearer admin-token" } },
    ));

    expect(response.status).toBe(200);
    expect(listAccountDeletionJobsAdmin).toHaveBeenCalledWith({
      adminAuthUserId: "11111111-1111-4111-8111-111111111111",
      status: "active",
      limit: 25,
    });
    const body = await response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: "22222222-2222-4222-8222-222222222222",
      status: "pending",
      phase: "storage_final",
      lease_state: "none",
    });
    expect(body.items[0]).not.toHaveProperty("user_id");
    expect(body.items[0]).not.toHaveProperty("storage_prefix");
    expect(body.items[0]).not.toHaveProperty("status_token_hash");
  });

  it.each([
    "?limit=101",
    "?status=unknown",
    "?limit=10&limit=20",
    "?user_id=secret",
  ])("rejects a non-contract query %s", async (query) => {
    const response = await GET(new Request(
      `https://api.example.test/api/admin/account-deletions${query}`,
      { headers: { authorization: "Bearer admin-token" } },
    ));
    expect(response.status).toBe(400);
    expect(listAccountDeletionJobsAdmin).not.toHaveBeenCalled();
  });
});
