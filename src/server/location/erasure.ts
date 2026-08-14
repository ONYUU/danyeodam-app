import "server-only";

import { randomUUID } from "node:crypto";

import { z } from "zod";

import { ApiError } from "@/server/http/api-error";
import { createSignalScopedServiceClient } from "@/server/supabase/service";

const itemSchema = z.object({
  id: z.number().int().positive(),
  bucket: z.enum(["personal-card-temp", "personal-cards"]),
  object_path: z.string().min(1).max(256),
  phase: z.enum(["first", "final"]),
}).strict();
const jobSchema = z.object({
  id: z.uuid(),
  scope: z.enum(["location_withdrawal", "location_correction", "personal_card"]),
  items: z.array(itemSchema).max(4),
}).strict();
const claimSchema = z.object({
  status: z.literal("ready"),
  jobs: z.array(jobSchema).max(2),
}).strict().superRefine((claim, context) => {
  const itemCount = claim.jobs.reduce((count, job) => count + job.items.length, 0);
  if (itemCount > 4) {
    context.addIssue({
      code: "custom",
      message: "claim exceeds the invocation Storage item cap",
      path: ["jobs"],
    });
  }
});
const recordSchema = z.object({
  status: z.enum(["recorded", "not_found", "forbidden"]),
}).strict();
const finishSchema = z.object({
  status: z.enum(["completed", "retry", "not_found", "forbidden", "unsupported_scope"]),
}).strict();
const purgeSchema = z.object({
  status: z.literal("purged"),
  facts_deleted: z.number().int().nonnegative(),
  disclosures_deleted: z.number().int().nonnegative(),
  resolved_corrections_deleted: z.number().int().nonnegative(),
  completed_erasure_receipts_deleted: z.number().int().nonnegative(),
  attempt_tombstones_deleted: z.number().int().nonnegative(),
}).strict();
const backlogSchema = z.object({
  status: z.literal("ready"),
  pending_jobs: z.number().int().nonnegative(),
  overdue_jobs: z.number().int().nonnegative(),
  high_attempt_jobs: z.number().int().nonnegative(),
  max_attempt_count: z.number().int().nonnegative(),
  oldest_requested_at: z.iso.datetime({ offset: true }).nullable(),
  open_corrections: z.number().int().nonnegative(),
  overdue_open_corrections: z.number().int().nonnegative(),
  oldest_open_requested_at: z.iso.datetime({ offset: true }).nullable(),
  pending_object_reconciliations: z.number().int().nonnegative(),
  overdue_object_reconciliations: z.number().int().nonnegative(),
  high_attempt_object_reconciliations: z.number().int().nonnegative(),
}).strict();
const objectReconciliationItemSchema = z.object({
  id: z.number().int().positive(),
  bucket: z.enum(["personal-card-temp", "personal-cards"]),
  object_path: z.string().min(1).max(256),
  phase: z.enum(["first", "final"]),
}).strict();
const objectReconciliationClaimSchema = z.object({
  status: z.literal("ready"),
  items: z.array(objectReconciliationItemSchema).max(4),
}).strict();
const objectReconciliationRecordSchema = z.object({
  status: z.enum(["recorded", "completed", "not_found", "forbidden", "referenced"]),
}).strict();

async function rpc(
  name: string,
  parameters: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const { data, error } = await createSignalScopedServiceClient(signal)
    .schema("api_private")
    .rpc(name, parameters)
    .abortSignal(signal);
  if (error !== null) throw new ApiError("INTERNAL");
  return data;
}

async function removeStorageObject(
  bucket: string,
  path: string,
  signal: AbortSignal,
): Promise<boolean> {
  const { error } = await createSignalScopedServiceClient(signal)
    .storage
    .from(bucket)
    .remove([path]);
  return error === null;
}

export type LocationMaintenanceDependencies = {
  createWorkerToken(): string;
  now(): number;
  rpc(
    name: string,
    parameters: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
  removeStorageObject(
    bucket: string,
    path: string,
    signal: AbortSignal,
  ): Promise<boolean>;
};

const defaultDependencies: LocationMaintenanceDependencies = {
  createWorkerToken: randomUUID,
  now: Date.now,
  rpc,
  removeStorageObject,
};

const DEFAULT_MAX_RUNTIME_MS = 45_000;
const DEFAULT_HARD_RUNTIME_MS = 48_000;
const DEFAULT_RPC_TIMEOUT_MS = 4_000;
const DEFAULT_STORAGE_TIMEOUT_MS = 5_000;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isInteger(value)) return fallback;
  return Math.min(Math.max(value, minimum), maximum);
}

class MaintenanceTimeoutError extends Error {}

async function runAbortable<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  hardSignal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  const callController = new AbortController();
  const callTimer = setTimeout(() => callController.abort(), timeoutMs);
  const signal = AbortSignal.any([hardSignal, callController.signal]);
  let removeAbortListener: () => void = () => {};
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(new MaintenanceTimeoutError("maintenance operation timed out"));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    });
    return await Promise.race([operation(signal), aborted]);
  } finally {
    clearTimeout(callTimer);
    removeAbortListener();
  }
}

export async function processLocationComplianceMaintenance(
  input: {
    jobLimit?: number;
    objectLimit?: number;
    purgeLimit?: number;
    maxRuntimeMs?: number;
    hardRuntimeMs?: number;
    rpcTimeoutMs?: number;
    storageTimeoutMs?: number;
  } = {},
  dependencies: LocationMaintenanceDependencies = defaultDependencies,
): Promise<{
  erasure: {
    claimed: number;
    completed: number;
    retry: number;
    superseded: number;
    failed_items: number;
  };
  object_reconciliation: {
    claimed: number;
    completed: number;
    deferred: number;
    superseded: number;
    failed_items: number;
  };
  retention: {
    facts_deleted: number;
    disclosures_deleted: number;
    resolved_corrections_deleted: number;
    completed_erasure_receipts_deleted: number;
    attempt_tombstones_deleted: number;
  };
  backlog: {
    pending_jobs: number;
    overdue_jobs: number;
    high_attempt_jobs: number;
    max_attempt_count: number;
    oldest_requested_at: string | null;
    open_corrections: number;
    overdue_open_corrections: number;
    oldest_open_requested_at: string | null;
    pending_object_reconciliations: number;
    overdue_object_reconciliations: number;
    high_attempt_object_reconciliations: number;
  };
}> {
  const workerToken = dependencies.createWorkerToken();
  const startedAt = dependencies.now();
  const softRuntimeMs = boundedInteger(
    input.maxRuntimeMs,
    DEFAULT_MAX_RUNTIME_MS,
    50,
    45_000,
  );
  const requestedHardRuntimeMs = boundedInteger(
    input.hardRuntimeMs,
    DEFAULT_HARD_RUNTIME_MS,
    100,
    50_000,
  );
  const hardRuntimeMs = requestedHardRuntimeMs > softRuntimeMs
    ? requestedHardRuntimeMs
    : Math.min(50_000, softRuntimeMs + 3_000);
  const softDeadline = startedAt + softRuntimeMs;
  const hardDeadline = startedAt + hardRuntimeMs;
  const hardController = new AbortController();
  const hardTimer = setTimeout(() => hardController.abort(), hardRuntimeMs);
  const rpcTimeoutMs = boundedInteger(
    input.rpcTimeoutMs,
    DEFAULT_RPC_TIMEOUT_MS,
    10,
    10_000,
  );
  const storageTimeoutMs = boundedInteger(
    input.storageTimeoutMs,
    DEFAULT_STORAGE_TIMEOUT_MS,
    10,
    10_000,
  );

  const assertHardBudget = () => {
    if (hardController.signal.aborted || dependencies.now() >= hardDeadline) {
      hardController.abort();
      throw new ApiError("INTERNAL");
    }
  };
  const rpcWithin = async (
    name: string,
    parameters: Record<string, unknown>,
  ): Promise<unknown> => {
    assertHardBudget();
    try {
      return await runAbortable(
        (signal) => dependencies.rpc(name, parameters, signal),
        hardController.signal,
        Math.min(rpcTimeoutMs, Math.max(1, hardDeadline - dependencies.now())),
      );
    } catch {
      throw new ApiError("INTERNAL");
    }
  };
  const removeWithin = async (bucket: string, path: string): Promise<boolean> => {
    assertHardBudget();
    try {
      return await runAbortable(
        (signal) => dependencies.removeStorageObject(bucket, path, signal),
        hardController.signal,
        Math.min(storageTimeoutMs, Math.max(1, hardDeadline - dependencies.now())),
      );
    } catch {
      if (hardController.signal.aborted || dependencies.now() >= hardDeadline) {
        throw new ApiError("INTERNAL");
      }
      return false;
    }
  };

  try {
    const objectClaim = objectReconciliationClaimSchema.parse(await rpcWithin(
      "claim_personal_card_field_object_cleanup",
      {
        p_worker_token: workerToken,
        p_limit: boundedInteger(input.objectLimit, 4, 1, 4),
      },
    ));
    let objectCompleted = 0;
    let objectDeferred = 0;
    let objectSuperseded = 0;
    let objectFailedItems = 0;
    for (const item of objectClaim.items) {
      const attempted = dependencies.now() < softDeadline;
      const deleted = attempted
        ? await removeWithin(item.bucket, item.object_path)
        : false;
      if (attempted && !deleted) objectFailedItems += 1;
      const recorded = objectReconciliationRecordSchema.parse(await rpcWithin(
        "record_personal_card_field_object_cleanup_result",
        {
          p_worker_token: workerToken,
          p_ledger_id: item.id,
          p_deleted: deleted,
        },
      ));
      if (recorded.status === "completed") objectCompleted += 1;
      else if (recorded.status === "recorded") objectDeferred += 1;
      else if (recorded.status === "not_found") objectSuperseded += 1;
      else throw new ApiError("INTERNAL");
    }

    const claim = claimSchema.parse(await rpcWithin("claim_data_erasure_jobs", {
      p_worker_token: workerToken,
      p_limit: boundedInteger(input.jobLimit, 2, 1, 2),
      p_item_limit: 4,
    }));

    let completed = 0;
    let retry = 0;
    let superseded = 0;
    let failedItems = 0;
    for (const job of claim.jobs) {
      let jobSuperseded = false;
      for (const item of job.items) {
        if (dependencies.now() >= softDeadline) break;
        const deleted = await removeWithin(item.bucket, item.object_path);
        if (!deleted) failedItems += 1;
        const recorded = recordSchema.parse(await rpcWithin(
          "record_data_erasure_item_result",
          {
            p_worker_token: workerToken,
            p_job_id: job.id,
            p_item_id: item.id,
            p_deleted: deleted,
          },
        ));
        if (recorded.status === "not_found") {
          jobSuperseded = true;
          break;
        }
        if (recorded.status !== "recorded") throw new ApiError("INTERNAL");
      }

      if (jobSuperseded) {
        superseded += 1;
        continue;
      }

      const finished = finishSchema.parse(await rpcWithin(
        "finish_data_erasure_job",
        {
          p_worker_token: workerToken,
          p_job_id: job.id,
        },
      ));
      if (finished.status === "completed") completed += 1;
      else if (finished.status === "retry") retry += 1;
      else if (finished.status === "not_found") superseded += 1;
      else throw new ApiError("INTERNAL");
    }

    const purge = purgeSchema.parse(await rpcWithin(
      "purge_expired_location_compliance_records",
      { p_limit: boundedInteger(input.purgeLimit, 250, 1, 1_000) },
    ));
    const backlog = backlogSchema.parse(await rpcWithin(
      "get_location_compliance_backlog",
      {},
    ));
    assertHardBudget();
    return {
      erasure: {
        claimed: claim.jobs.length,
        completed,
        retry,
        superseded,
        failed_items: failedItems,
      },
      object_reconciliation: {
        claimed: objectClaim.items.length,
        completed: objectCompleted,
        deferred: objectDeferred,
        superseded: objectSuperseded,
        failed_items: objectFailedItems,
      },
      retention: {
        facts_deleted: purge.facts_deleted,
        disclosures_deleted: purge.disclosures_deleted,
        resolved_corrections_deleted: purge.resolved_corrections_deleted,
        completed_erasure_receipts_deleted: purge.completed_erasure_receipts_deleted,
        attempt_tombstones_deleted: purge.attempt_tombstones_deleted,
      },
      backlog: {
        pending_jobs: backlog.pending_jobs,
        overdue_jobs: backlog.overdue_jobs,
        high_attempt_jobs: backlog.high_attempt_jobs,
        max_attempt_count: backlog.max_attempt_count,
        oldest_requested_at: backlog.oldest_requested_at,
        open_corrections: backlog.open_corrections,
        overdue_open_corrections: backlog.overdue_open_corrections,
        oldest_open_requested_at: backlog.oldest_open_requested_at,
        pending_object_reconciliations: backlog.pending_object_reconciliations,
        overdue_object_reconciliations: backlog.overdue_object_reconciliations,
        high_attempt_object_reconciliations:
          backlog.high_attempt_object_reconciliations,
      },
    };
  } finally {
    clearTimeout(hardTimer);
    hardController.abort();
  }
}
