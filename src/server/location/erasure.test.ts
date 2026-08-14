import { describe, expect, it, vi } from "vitest";

import {
  processLocationComplianceMaintenance,
  type LocationMaintenanceDependencies,
} from "@/server/location/erasure";

const workerToken = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";

const purge = {
  status: "purged",
  facts_deleted: 1,
  disclosures_deleted: 2,
  resolved_corrections_deleted: 3,
  completed_erasure_receipts_deleted: 4,
  attempt_tombstones_deleted: 5,
};
const backlog = {
  status: "ready",
  pending_jobs: 5,
  overdue_jobs: 0,
  high_attempt_jobs: 0,
  max_attempt_count: 2,
  oldest_requested_at: "2026-08-12T00:00:00.000Z",
  open_corrections: 1,
  overdue_open_corrections: 0,
  oldest_open_requested_at: "2026-08-12T00:30:00.000Z",
  pending_object_reconciliations: 0,
  overdue_object_reconciliations: 0,
  high_attempt_object_reconciliations: 0,
};

function dependencies(input: {
  jobs?: unknown[];
  recordResults?: ("recorded" | "not_found" | "forbidden")[];
  finishResult?: "completed" | "retry" | "not_found" | "forbidden" | "unsupported_scope";
  deletes?: boolean[];
  backlogResult?: typeof backlog;
  objectItems?: unknown[];
  objectRecordResults?: ("recorded" | "completed" | "not_found" | "forbidden" | "referenced")[];
  stalledRpc?: string;
  now?: () => number;
} = {}): LocationMaintenanceDependencies & {
  rpc: ReturnType<typeof vi.fn>;
  removeStorageObject: ReturnType<typeof vi.fn>;
} {
  const recordResults = [...(input.recordResults ?? [])];
  const objectRecordResults = [...(input.objectRecordResults ?? [])];
  const rpc = vi.fn(async (name: string) => {
    if (name === input.stalledRpc) return await new Promise<never>(() => undefined);
    if (name === "claim_personal_card_field_object_cleanup") {
      return { status: "ready", items: input.objectItems ?? [] };
    }
    if (name === "record_personal_card_field_object_cleanup_result") {
      return { status: objectRecordResults.shift() ?? "recorded" };
    }
    if (name === "claim_data_erasure_jobs") {
      return { status: "ready", jobs: input.jobs ?? [] };
    }
    if (name === "record_data_erasure_item_result") {
      return { status: recordResults.shift() ?? "recorded" };
    }
    if (name === "finish_data_erasure_job") {
      return { status: input.finishResult ?? "completed" };
    }
    if (name === "purge_expired_location_compliance_records") return purge;
    if (name === "get_location_compliance_backlog") {
      return input.backlogResult ?? backlog;
    }
    throw new Error(`unexpected RPC: ${name}`);
  });
  const deleteResults = [...(input.deletes ?? [])];
  const removeStorageObject = vi.fn(async () => deleteResults.shift() ?? true);
  return {
    createWorkerToken: () => workerToken,
    now: input.now ?? Date.now,
    rpc,
    removeStorageObject,
  };
}

describe("location compliance erasure worker", () => {
  it("processes first and final deletion phases before completing a job", async () => {
    const deps = dependencies({
      jobs: [{
        id: jobId,
        scope: "location_withdrawal",
        items: [
          { id: 1, bucket: "personal-card-temp", object_path: "temp/a", phase: "first" },
          { id: 2, bucket: "personal-cards", object_path: "permanent/a", phase: "final" },
        ],
      }],
    });

    const result = await processLocationComplianceMaintenance(
      { jobLimit: 1, purgeLimit: 10 },
      deps,
    );

    expect(result.erasure).toEqual({
      claimed: 1,
      completed: 1,
      retry: 0,
      superseded: 0,
      failed_items: 0,
    });
    expect(result.object_reconciliation).toEqual({
      claimed: 0,
      completed: 0,
      deferred: 0,
      superseded: 0,
      failed_items: 0,
    });
    expect(deps.removeStorageObject.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ["personal-card-temp", "temp/a"],
      ["personal-cards", "permanent/a"],
    ]);
    expect(deps.rpc).toHaveBeenCalledWith("finish_data_erasure_job", {
      p_worker_token: workerToken,
      p_job_id: jobId,
    }, expect.any(AbortSignal));
    expect(result.retention).toEqual({
      facts_deleted: 1,
      disclosures_deleted: 2,
      resolved_corrections_deleted: 3,
      completed_erasure_receipts_deleted: 4,
      attempt_tombstones_deleted: 5,
    });
  });

  it("processes personal-card deletion jobs through the same two-pass worker", async () => {
    const deps = dependencies({
      jobs: [{
        id: jobId,
        scope: "personal_card",
        items: [{
          id: 1,
          bucket: "personal-cards",
          object_path: "owner/deleted-card.webp",
          phase: "first",
        }],
      }],
    });

    const result = await processLocationComplianceMaintenance({}, deps);

    expect(result.erasure.completed).toBe(1);
    expect(deps.removeStorageObject).toHaveBeenCalledWith(
      "personal-cards",
      "owner/deleted-card.webp",
      expect.any(AbortSignal),
    );
    expect(deps.rpc).toHaveBeenCalledWith("finish_data_erasure_job", {
      p_worker_token: workerToken,
      p_job_id: jobId,
    }, expect.any(AbortSignal));
  });

  it("records failed storage deletion and leaves the job retryable", async () => {
    const deps = dependencies({
      jobs: [{
        id: jobId,
        scope: "location_correction",
        items: [{
          id: 1,
          bucket: "personal-cards",
          object_path: "permanent/a",
          phase: "first",
        }],
      }],
      deletes: [false],
      finishResult: "retry",
    });
    const result = await processLocationComplianceMaintenance({}, deps);
    expect(result.erasure).toMatchObject({ retry: 1, failed_items: 1, completed: 0 });
    expect(deps.rpc).toHaveBeenCalledWith("record_data_erasure_item_result", {
      p_worker_token: workerToken,
      p_job_id: jobId,
      p_item_id: 1,
      p_deleted: false,
    }, expect.any(AbortSignal));
  });

  it("stops a superseded job without touching its remaining manifest", async () => {
    const deps = dependencies({
      jobs: [{
        id: jobId,
        scope: "location_correction",
        items: [
          { id: 1, bucket: "personal-cards", object_path: "a", phase: "first" },
          { id: 2, bucket: "personal-cards", object_path: "b", phase: "first" },
        ],
      }],
      recordResults: ["not_found"],
    });
    const result = await processLocationComplianceMaintenance({}, deps);
    expect(result.erasure).toMatchObject({ superseded: 1, completed: 0 });
    expect(deps.removeStorageObject).toHaveBeenCalledTimes(1);
    expect(deps.rpc).not.toHaveBeenCalledWith(
      "finish_data_erasure_job",
      expect.anything(),
    );
  });

  it("fails closed on forbidden worker ownership and exposes only aggregate backlog", async () => {
    const deps = dependencies({
      jobs: [{
        id: jobId,
        scope: "location_withdrawal",
        items: [{ id: 1, bucket: "personal-cards", object_path: "a", phase: "first" }],
      }],
      recordResults: ["forbidden"],
    });
    await expect(processLocationComplianceMaintenance({}, deps))
      .rejects.toMatchObject({ code: "INTERNAL", status: 500 });

    const aggregate = await processLocationComplianceMaintenance({}, dependencies());
    expect(aggregate.backlog).toEqual({
      pending_jobs: 5,
      overdue_jobs: 0,
      high_attempt_jobs: 0,
      max_attempt_count: 2,
      oldest_requested_at: "2026-08-12T00:00:00.000Z",
      open_corrections: 1,
      overdue_open_corrections: 0,
      oldest_open_requested_at: "2026-08-12T00:30:00.000Z",
      pending_object_reconciliations: 0,
      overdue_object_reconciliations: 0,
      high_attempt_object_reconciliations: 0,
    });
    expect(JSON.stringify(aggregate)).not.toContain(jobId);
  });

  it("keeps an ambiguous field upload durable through two separate cleanup phases", async () => {
    const firstDeps = dependencies({
      objectItems: [{
        id: 9,
        bucket: "personal-cards",
        object_path: "user/ambiguous.webp",
        phase: "first",
      }],
      objectRecordResults: ["recorded"],
    });
    const first = await processLocationComplianceMaintenance({}, firstDeps);
    expect(first.object_reconciliation).toEqual({
      claimed: 1,
      completed: 0,
      deferred: 1,
      superseded: 0,
      failed_items: 0,
    });

    const finalDeps = dependencies({
      objectItems: [{
        id: 9,
        bucket: "personal-cards",
        object_path: "user/ambiguous.webp",
        phase: "final",
      }],
      objectRecordResults: ["completed"],
    });
    const final = await processLocationComplianceMaintenance({}, finalDeps);
    expect(final.object_reconciliation.completed).toBe(1);
    expect(firstDeps.removeStorageObject).toHaveBeenCalledWith(
      "personal-cards",
      "user/ambiguous.webp",
      expect.any(AbortSignal),
    );
    expect(finalDeps.removeStorageObject).toHaveBeenCalledWith(
      "personal-cards",
      "user/ambiguous.webp",
      expect.any(AbortSignal),
    );
  });

  it("releases unprocessed leases at the runtime budget and still runs retention and backlog", async () => {
    let now = 0;
    const deps = dependencies({
      now: () => now,
      objectItems: [
        { id: 9, bucket: "personal-cards", object_path: "user/one.webp", phase: "first" },
        { id: 10, bucket: "personal-cards", object_path: "user/two.webp", phase: "first" },
      ],
      jobs: [{
        id: jobId,
        scope: "location_withdrawal",
        items: [
          { id: 1, bucket: "personal-cards", object_path: "user/three.webp", phase: "first" },
        ],
      }],
      finishResult: "retry",
    });
    deps.removeStorageObject.mockImplementation(async () => {
      now = 46_000;
      return true;
    });

    const result = await processLocationComplianceMaintenance(
      { maxRuntimeMs: 45_000 },
      deps,
    );

    expect(deps.removeStorageObject).toHaveBeenCalledTimes(1);
    expect(deps.rpc).toHaveBeenCalledWith(
      "record_personal_card_field_object_cleanup_result",
      {
        p_worker_token: workerToken,
        p_ledger_id: 10,
        p_deleted: false,
      },
      expect.any(AbortSignal),
    );
    expect(deps.rpc).toHaveBeenCalledWith("finish_data_erasure_job", {
      p_worker_token: workerToken,
      p_job_id: jobId,
    }, expect.any(AbortSignal));
    expect(deps.rpc).toHaveBeenCalledWith(
      "purge_expired_location_compliance_records",
      { p_limit: 250 },
      expect.any(AbortSignal),
    );
    expect(deps.rpc).toHaveBeenCalledWith(
      "get_location_compliance_backlog",
      {},
      expect.any(AbortSignal),
    );
    expect(result.object_reconciliation).toMatchObject({
      claimed: 2,
      deferred: 2,
      failed_items: 0,
    });
    expect(result.erasure).toMatchObject({ claimed: 1, retry: 1, failed_items: 0 });
  });

  it("times out a stalled Storage call and records a retryable aggregate failure", async () => {
    const deps = dependencies({
      objectItems: [{
        id: 9,
        bucket: "personal-cards",
        object_path: "user/stalled.webp",
        phase: "first",
      }],
    });
    deps.removeStorageObject.mockImplementation(
      () => new Promise<boolean>(() => undefined),
    );

    const result = await processLocationComplianceMaintenance(
      { maxRuntimeMs: 1_000, storageTimeoutMs: 100 },
      deps,
    );

    expect(result.object_reconciliation).toMatchObject({
      claimed: 1,
      deferred: 1,
      failed_items: 1,
    });
    expect(deps.rpc).toHaveBeenCalledWith(
      "record_personal_card_field_object_cleanup_result",
      {
        p_worker_token: workerToken,
        p_ledger_id: 9,
        p_deleted: false,
      },
      expect.any(AbortSignal),
    );
  });

  it("fails within the hard budget even when a Storage dependency ignores abort", async () => {
    const deps = dependencies({
      now: () => 0,
      objectItems: [{
        id: 9,
        bucket: "personal-cards",
        object_path: "user/ignores-abort.webp",
        phase: "first",
      }],
    });
    deps.removeStorageObject.mockImplementation(
      () => new Promise<boolean>(() => undefined),
    );

    await expect(processLocationComplianceMaintenance(
      {
        maxRuntimeMs: 50,
        hardRuntimeMs: 100,
        storageTimeoutMs: 10_000,
      },
      deps,
    )).rejects.toMatchObject({ code: "INTERNAL", status: 500 });
    expect(deps.rpc).not.toHaveBeenCalledWith(
      "record_personal_card_field_object_cleanup_result",
      expect.anything(),
      expect.anything(),
    );
  });

  it("does not finish a job when recording a Storage result times out", async () => {
    const deps = dependencies({
      jobs: [{
        id: jobId,
        scope: "location_withdrawal",
        items: [{
          id: 1,
          bucket: "personal-cards",
          object_path: "user/record-timeout.webp",
          phase: "first",
        }],
      }],
      stalledRpc: "record_data_erasure_item_result",
    });

    await expect(processLocationComplianceMaintenance(
      { maxRuntimeMs: 200, hardRuntimeMs: 300, rpcTimeoutMs: 50 },
      deps,
    )).rejects.toMatchObject({ code: "INTERNAL", status: 500 });
    expect(deps.rpc).not.toHaveBeenCalledWith(
      "finish_data_erasure_job",
      expect.anything(),
      expect.anything(),
    );
  });

  it("rejects a database claim that exceeds the total four-item bound", async () => {
    const item = (id: number) => ({
      id,
      bucket: "personal-cards",
      object_path: `user/${id}.webp`,
      phase: "first",
    });
    const deps = dependencies({
      jobs: [
        {
          id: jobId,
          scope: "location_withdrawal",
          items: [item(1), item(2), item(3)],
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          scope: "location_correction",
          items: [item(4), item(5)],
        },
      ],
    });

    await expect(processLocationComplianceMaintenance({}, deps)).rejects.toBeDefined();
    expect(deps.removeStorageObject).not.toHaveBeenCalled();
    expect(deps.rpc).not.toHaveBeenCalledWith(
      "purge_expired_location_compliance_records",
      expect.anything(),
      expect.anything(),
    );
  });
});
