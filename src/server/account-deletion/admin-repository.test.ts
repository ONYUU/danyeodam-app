import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();

vi.mock("@/server/supabase/service", () => ({
  getServiceClient: () => ({ schema: () => ({ rpc }) }),
  createSignalScopedServiceClient: () => ({ schema: () => ({ rpc }) }),
}));

import {
  listAccountDeletionJobsAdmin,
  retryAccountDeletionJobAdmin,
} from "@/server/account-deletion/repository";

const adminAuthUserId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const clientActionId = "33333333-3333-4333-8333-333333333333";

const item = {
  id: requestId,
  status: "processing",
  phase: "database",
  last_error_code: null,
  last_error_at: null,
  attempt_count: 4,
  consecutive_failure_count: 0,
  requested_at: "2026-08-12T00:00:00.000Z",
  complete_by: "2026-08-13T00:00:00.000Z",
  next_attempt_at: null,
  lease_state: "active",
  lease_expires_at: "2026-08-12T01:10:00.000Z",
  database_deleted_at: null,
  completed_at: null,
  updated_at: "2026-08-12T01:00:00.000Z",
};

describe("account deletion administrator repository", () => {
  beforeEach(() => rpc.mockReset());

  it("parses the bounded operational projection and passes exact RPC inputs", async () => {
    rpc.mockResolvedValue({ data: { status: "ready", items: [item] }, error: null });
    await expect(listAccountDeletionJobsAdmin({
      adminAuthUserId,
      status: "processing",
      limit: 25,
    })).resolves.toEqual([item]);
    expect(rpc).toHaveBeenCalledWith("list_account_deletion_jobs_admin", {
      p_admin_auth_user_id: adminAuthUserId,
      p_status: "processing",
      p_limit: 25,
    });
  });

  it("fails closed if an identifying field appears in the list projection", async () => {
    rpc.mockResolvedValue({
      data: { status: "ready", items: [{ ...item, user_id: adminAuthUserId }] },
      error: null,
    });
    await expect(listAccountDeletionJobsAdmin({
      adminAuthUserId,
      status: "active",
      limit: 50,
    })).rejects.toThrow();
  });

  it("accepts duplicate retry replay and passes the canonical audit payload", async () => {
    rpc.mockResolvedValue({
      data: {
        status: "duplicate",
        id: requestId,
        original_status: "retry_scheduled",
        next_attempt_at: "2026-08-12T01:00:00.000Z",
      },
      error: null,
    });
    await expect(retryAccountDeletionJobAdmin({
      adminAuthUserId,
      requestId,
      clientActionId,
      reasonCode: "WORKER_STALLED",
      note: "Reviewed worker lease",
    })).resolves.toMatchObject({ status: "duplicate", id: requestId });
    expect(rpc).toHaveBeenCalledWith("retry_account_deletion_job_admin", {
      p_admin_auth_user_id: adminAuthUserId,
      p_request_id: requestId,
      p_client_action_id: clientActionId,
      p_reason_code: "WORKER_STALLED",
      p_note: "Reviewed worker lease",
    });
  });

  it("maps a mismatched client action to the canonical conflict", async () => {
    rpc.mockResolvedValue({ data: { status: "idempotency_conflict" }, error: null });
    await expect(retryAccountDeletionJobAdmin({
      adminAuthUserId,
      requestId,
      clientActionId,
      reasonCode: "OVERDUE",
      note: "Reviewed overdue deletion",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  });
});
