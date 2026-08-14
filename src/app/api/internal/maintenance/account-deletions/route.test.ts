import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  processAccountDeletionJobs,
  getServerEnvironment,
  logSafeServerError,
} = vi.hoisted(() => ({
  processAccountDeletionJobs: vi.fn(),
  getServerEnvironment: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/account-deletion/service", () => ({ processAccountDeletionJobs }));
vi.mock("@/server/env", () => ({ getServerEnvironment }));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));

import { GET } from "@/app/api/internal/maintenance/account-deletions/route";

const cronSecret = "c".repeat(32);
const healthyResult = {
  leased: 1,
  advanced: 1,
  completed: 0,
  retrying: 0,
  failed_external_operations: 0,
  backlog: {
    pending_jobs: 1,
    overdue_jobs: 0,
    high_attempt_jobs: 0,
    max_attempt_count: 1,
    oldest_requested_at: "2026-08-12T00:00:00.000Z",
    retrying_jobs: 0,
    completed_receipts: 0,
  },
};

function maintenanceRequest(secret = cronSecret): Request {
  return new Request(
    "https://api.example.test/api/internal/maintenance/account-deletions",
    { headers: { authorization: `Bearer ${secret}` } },
  );
}

describe("GET /api/internal/maintenance/account-deletions", () => {
  beforeEach(() => {
    processAccountDeletionJobs.mockReset();
    getServerEnvironment.mockReset();
    logSafeServerError.mockReset();
    getServerEnvironment.mockReturnValue({ CRON_SECRET: cronSecret });
  });

  it("returns aggregate worker and backlog counters without identifiers", async () => {
    processAccountDeletionJobs.mockResolvedValue(healthyResult);

    const response = await GET(maintenanceRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(healthyResult);
    expect(processAccountDeletionJobs).toHaveBeenCalledWith();
  });

  it("fails closed before leasing work for an invalid Cron bearer", async () => {
    const response = await GET(maintenanceRequest("wrong-secret"));

    expect(response.status).toBe(401);
    expect(processAccountDeletionJobs).not.toHaveBeenCalled();
    expect(JSON.stringify(logSafeServerError.mock.calls)).not.toContain("wrong-secret");
  });

  it("emits aggregate alerts while keeping failed jobs retryable", async () => {
    processAccountDeletionJobs.mockResolvedValue({
      ...healthyResult,
      retrying: 1,
      failed_external_operations: 1,
      backlog: {
        ...healthyResult.backlog,
        overdue_jobs: 1,
        high_attempt_jobs: 1,
        max_attempt_count: 12,
        retrying_jobs: 1,
      },
    });

    const response = await GET(maintenanceRequest());

    expect(response.status).toBe(500);
    expect(logSafeServerError).toHaveBeenCalledWith(expect.objectContaining({
      operation: "account_deletion_maintenance_alert",
      accountDeletionCounts: expect.objectContaining({
        overdue_jobs: 1,
        high_attempt_jobs: 1,
      }),
    }));
    expect(JSON.stringify(logSafeServerError.mock.calls)).not.toContain(cronSecret);
  });
});
