import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  hasValidCronAuthorization,
  processLocationComplianceMaintenance,
  logSafeServerError,
} = vi.hoisted(() => ({
  hasValidCronAuthorization: vi.fn(),
  processLocationComplianceMaintenance: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/personal-cards/cron-auth", () => ({ hasValidCronAuthorization }));
vi.mock("@/server/location/erasure", () => ({ processLocationComplianceMaintenance }));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));
vi.mock("@/server/env", () => ({
  getServerEnvironment: () => ({ CRON_SECRET: "test-cron-secret-000000000000000000000001" }),
}));

import { GET } from "@/app/api/internal/maintenance/location-compliance/route";

const healthyResult = {
  erasure: { claimed: 0, completed: 0, retry: 0, superseded: 0, failed_items: 0 },
  object_reconciliation: {
    claimed: 0,
    completed: 0,
    deferred: 0,
    superseded: 0,
    failed_items: 0,
  },
  retention: {
    facts_deleted: 0,
    disclosures_deleted: 0,
    resolved_corrections_deleted: 0,
    completed_erasure_receipts_deleted: 0,
    attempt_tombstones_deleted: 0,
  },
  backlog: {
    pending_jobs: 0,
    overdue_jobs: 0,
    high_attempt_jobs: 0,
    max_attempt_count: 0,
    oldest_requested_at: null,
    open_corrections: 0,
    overdue_open_corrections: 0,
    oldest_open_requested_at: null,
    pending_object_reconciliations: 0,
    overdue_object_reconciliations: 0,
    high_attempt_object_reconciliations: 0,
  },
};

function request(): Request {
  return new Request("https://api.example.test/api/internal/maintenance/location-compliance", {
    headers: { authorization: "Bearer cron-secret" },
  });
}

describe("location compliance maintenance route", () => {
  beforeEach(() => {
    hasValidCronAuthorization.mockReset();
    processLocationComplianceMaintenance.mockReset();
    logSafeServerError.mockReset();
    hasValidCronAuthorization.mockReturnValue(true);
    processLocationComplianceMaintenance.mockResolvedValue(healthyResult);
  });

  it("returns aggregate maintenance evidence for an authorized healthy run", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(healthyResult);
    expect(hasValidCronAuthorization).toHaveBeenCalledWith(
      "Bearer cron-secret",
      "test-cron-secret-000000000000000000000001",
    );
  });

  it("does not alert while object reconciliation is waiting for a future deletion boundary", async () => {
    processLocationComplianceMaintenance.mockResolvedValue({
      ...healthyResult,
      backlog: {
        ...healthyResult.backlog,
        pending_object_reconciliations: 2,
        overdue_object_reconciliations: 0,
      },
    });

    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(logSafeServerError).not.toHaveBeenCalled();
  });

  it("fails closed and logs only aggregate counts when backlog requires attention", async () => {
    processLocationComplianceMaintenance.mockResolvedValue({
      ...healthyResult,
      erasure: { ...healthyResult.erasure, failed_items: 2 },
      backlog: {
        pending_jobs: 9,
        overdue_jobs: 3,
        high_attempt_jobs: 1,
        max_attempt_count: 27,
        oldest_requested_at: "2026-08-11T00:00:00.000Z",
        open_corrections: 4,
        overdue_open_corrections: 2,
        oldest_open_requested_at: "2026-08-10T00:00:00.000Z",
        pending_object_reconciliations: 6,
        overdue_object_reconciliations: 2,
        high_attempt_object_reconciliations: 1,
      },
    });
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(logSafeServerError).toHaveBeenCalledWith(expect.objectContaining({
      operation: "location_compliance_maintenance_alert",
      category: "database",
      locationComplianceCounts: {
        failed_items: 2,
        object_failed_items: 0,
        pending_jobs: 9,
        overdue_jobs: 3,
        high_attempt_jobs: 1,
        max_attempt_count: 27,
        open_corrections: 4,
        overdue_open_corrections: 2,
        pending_object_reconciliations: 6,
        overdue_object_reconciliations: 2,
        high_attempt_object_reconciliations: 1,
      },
    }));
    expect(JSON.stringify(logSafeServerError.mock.calls))
      .not.toContain("22222222-2222-4222-8222-222222222222");
  });

  it("rejects an invalid scheduler secret before running the worker", async () => {
    hasValidCronAuthorization.mockReturnValue(false);
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(processLocationComplianceMaintenance).not.toHaveBeenCalled();
  });
});
