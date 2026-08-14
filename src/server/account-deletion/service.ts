import "server-only";

import { randomUUID } from "node:crypto";

import { ApiError } from "@/server/http/api-error";
import {
  advanceAccountDeletionJob,
  claimAccountDeletionJobs,
  failAccountDeletionJob,
  getAccountDeletionBacklog,
  markAccountDeletionAuthRemoved,
  recordAccountDeletionStorageResult,
  registerAccountDeletionStoragePaths,
  type AccountDeletionBacklog,
  type AccountDeletionLeasedJob,
  type AccountDeletionWorkerErrorCode,
} from "@/server/account-deletion/repository";
import {
  deleteAccountStoragePath,
  listAccountStoragePaths,
} from "@/server/account-deletion/storage";
import { createSignalScopedServiceClient } from "@/server/supabase/service";

export function isMissingAuthUserError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && Reflect.get(error, "code") === "user_not_found";
}

export type AccountDeletionWorkerDependencies = {
  createWorkerToken(): string;
  now(): number;
  claim(input: { workerToken: string; signal: AbortSignal }): Promise<AccountDeletionLeasedJob[]>;
  listStorage(input: {
    prefix: string;
    limit: number;
    signal: AbortSignal;
  }): ReturnType<typeof listAccountStoragePaths>;
  deleteStorage(input: {
    bucket: "personal-card-temp" | "personal-cards";
    objectPath: string;
    signal: AbortSignal;
  }): Promise<boolean>;
  registerPaths(input: {
    requestId: string;
    workerToken: string;
    paths: { bucket: "personal-card-temp" | "personal-cards"; object_path: string }[];
    signal: AbortSignal;
  }): Promise<void>;
  recordStorage(input: {
    requestId: string;
    workerToken: string;
    itemId: number;
    pass: "first" | "final";
    deleted: boolean;
    signal: AbortSignal;
  }): Promise<"recorded" | "retry" | "not_found" | "forbidden" | "invalid">;
  deleteAuthUser(input: { authUserId: string; signal: AbortSignal }): Promise<void>;
  markAuthRemoved(input: {
    requestId: string;
    workerToken: string;
    authUserId: string;
    signal: AbortSignal;
  }): Promise<"removed" | "not_found" | "forbidden">;
  advance(input: {
    requestId: string;
    workerToken: string;
    completedPhase: AccountDeletionLeasedJob["phase"];
    prefixScanEmpty: boolean;
    signal: AbortSignal;
  }): Promise<"advanced" | "retry" | "completed" | "not_ready" | "forbidden" | "invalid">;
  fail(input: {
    requestId: string;
    workerToken: string;
    errorCode: AccountDeletionWorkerErrorCode;
    signal: AbortSignal;
  }): Promise<"retrying" | "forbidden" | "invalid">;
  backlog(signal: AbortSignal): Promise<AccountDeletionBacklog>;
};

const defaultDependencies: AccountDeletionWorkerDependencies = {
  createWorkerToken: randomUUID,
  now: Date.now,
  claim: claimAccountDeletionJobs,
  listStorage: listAccountStoragePaths,
  deleteStorage: deleteAccountStoragePath,
  registerPaths: registerAccountDeletionStoragePaths,
  recordStorage: recordAccountDeletionStorageResult,
  async deleteAuthUser({ authUserId, signal }): Promise<void> {
    const { error } = await createSignalScopedServiceClient(signal)
      .auth.admin.deleteUser(authUserId, false);
    if (error !== null && !isMissingAuthUserError(error)) {
      throw new Error("Auth deletion failed");
    }
  },
  markAuthRemoved: markAccountDeletionAuthRemoved,
  advance: advanceAccountDeletionJob,
  fail: failAccountDeletionJob,
  async backlog(signal) {
    return getAccountDeletionBacklog(signal);
  },
};

const DEFAULT_SOFT_RUNTIME_MS = 45_000;
const DEFAULT_HARD_RUNTIME_MS = 48_000;
const DEFAULT_RPC_TIMEOUT_MS = 4_000;
const DEFAULT_STORAGE_TIMEOUT_MS = 5_000;
const DEFAULT_AUTH_TIMEOUT_MS = 8_000;
const FAILURE_RECORD_TIMEOUT_MS = 2_000;
const MAX_HARD_BUDGET_MARGIN_MS = 250;

class AccountDeletionOperationError extends Error {
  constructor(readonly code: AccountDeletionWorkerErrorCode) {
    super("Account deletion operation failed");
    this.name = "AccountDeletionOperationError";
  }
}

class AccountDeletionTimeoutError extends Error {}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isInteger(value)) return fallback;
  return Math.min(Math.max(value, minimum), maximum);
}

async function runAbortable<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  hardSignal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = AbortSignal.any([hardSignal, controller.signal]);
  let removeListener: () => void = () => {};
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(new AccountDeletionTimeoutError());
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      removeListener = () => signal.removeEventListener("abort", onAbort);
    });
    return await Promise.race([operation(signal), aborted]);
  } finally {
    clearTimeout(timer);
    removeListener();
  }
}

function defaultErrorCode(
  phase: AccountDeletionLeasedJob["phase"],
): AccountDeletionWorkerErrorCode {
  if (phase === "storage_initial" || phase === "storage_final") {
    return "STORAGE_DELETE_FAILED";
  }
  if (phase === "database") return "DATABASE_DELETE_FAILED";
  if (phase === "auth") return "AUTH_DELETE_FAILED";
  return "WORKER_UNEXPECTED";
}

export async function processAccountDeletionJobs(
  input: {
    softRuntimeMs?: number;
    hardRuntimeMs?: number;
    rpcTimeoutMs?: number;
    storageTimeoutMs?: number;
    authTimeoutMs?: number;
  } = {},
  dependencies: AccountDeletionWorkerDependencies = defaultDependencies,
): Promise<{
  leased: number;
  advanced: number;
  completed: number;
  retrying: number;
  failed_external_operations: number;
  backlog: Omit<AccountDeletionBacklog, "status">;
}> {
  const startedAt = dependencies.now();
  const softRuntimeMs = boundedInteger(
    input.softRuntimeMs,
    DEFAULT_SOFT_RUNTIME_MS,
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
  const rpcTimeoutMs = boundedInteger(input.rpcTimeoutMs, DEFAULT_RPC_TIMEOUT_MS, 10, 10_000);
  const storageTimeoutMs = boundedInteger(
    input.storageTimeoutMs,
    DEFAULT_STORAGE_TIMEOUT_MS,
    10,
    10_000,
  );
  const authTimeoutMs = boundedInteger(input.authTimeoutMs, DEFAULT_AUTH_TIMEOUT_MS, 10, 15_000);
  const hardBudgetMarginMs = Math.min(
    MAX_HARD_BUDGET_MARGIN_MS,
    Math.max(1, Math.floor(hardRuntimeMs / 100)),
  );
  const backlogReserveMs = rpcTimeoutMs + hardBudgetMarginMs;
  const failureReserveMs = FAILURE_RECORD_TIMEOUT_MS + backlogReserveMs;

  const remainingHardBudgetMs = (): number => Math.max(
    0,
    hardDeadline - dependencies.now(),
  );

  const hasHardBudget = (requiredMs: number): boolean => (
    !hardController.signal.aborted
    && remainingHardBudgetMs() >= requiredMs
  );

  const requireHardBudget = (requiredMs: number): void => {
    if (!hasHardBudget(requiredMs)) {
      throw new AccountDeletionOperationError("WORKER_TIMEOUT");
    }
  };

  const within = async <T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    reserveAfterMs = 0,
  ): Promise<T> => {
    const remainingMs = remainingHardBudgetMs();
    if (hardController.signal.aborted || remainingMs <= 0) {
      hardController.abort();
      throw new AccountDeletionTimeoutError();
    }
    const operationBudgetMs = Math.min(
      timeoutMs,
      Math.floor(remainingMs - reserveAfterMs),
    );
    if (operationBudgetMs < 1) {
      throw new AccountDeletionTimeoutError();
    }
    return runAbortable(
      operation,
      hardController.signal,
      operationBudgetMs,
    );
  };

  let leased = 0;
  let advanced = 0;
  let completed = 0;
  let retrying = 0;
  let failedExternalOperations = 0;

  try {
    while (dependencies.now() < softDeadline) {
      // A successful claim can still return a phase that cannot safely start.
      // Reserve enough time to record that lease as retrying and to publish
      // backlog health before taking ownership of another job.
      if (!hasHardBudget(rpcTimeoutMs + failureReserveMs)) break;

      // A token identifies one lease generation, not one cron invocation.
      // Late completion from a timed-out RPC must never be authorized against
      // a later lease of the same job in this drain loop.
      const workerToken = dependencies.createWorkerToken();
      const jobs = await within(
        (signal) => dependencies.claim({ workerToken, signal }),
        rpcTimeoutMs,
        failureReserveMs,
      );
      if (jobs.length === 0) break;
      leased += jobs.length;

      for (const job of jobs) {
        let externalFailureCounted = false;
        try {
          if (dependencies.now() >= softDeadline) {
            throw new AccountDeletionOperationError("WORKER_TIMEOUT");
          }

          if (job.phase === "storage_initial" || job.phase === "storage_final") {
            if (job.storage_prefix === null) {
              throw new AccountDeletionOperationError("WORKER_UNEXPECTED");
            }

            if (job.storage_items.length > 0) {
              let itemFailed = false;
              for (const item of job.storage_items) {
                if (dependencies.now() >= softDeadline) {
                  throw new AccountDeletionOperationError("WORKER_TIMEOUT");
                }

                // Never start an external delete unless its durable result,
                // bounded failure record, backlog read, and hard margin all fit.
                requireHardBudget(storageTimeoutMs + rpcTimeoutMs + failureReserveMs);
                const deleted = await within(
                  (signal) => dependencies.deleteStorage({
                    bucket: item.bucket,
                    objectPath: item.object_path,
                    signal,
                  }),
                  storageTimeoutMs,
                  rpcTimeoutMs + failureReserveMs,
                );
                if (!deleted) {
                  itemFailed = true;
                  failedExternalOperations += 1;
                  externalFailureCounted = true;
                }
                const recorded = await within(
                  (signal) => dependencies.recordStorage({
                    requestId: job.id,
                    workerToken,
                    itemId: item.id,
                    pass: item.pass,
                    deleted,
                    signal,
                  }),
                  rpcTimeoutMs,
                  failureReserveMs,
                );
                if (recorded === "retry") itemFailed = true;
                else if (recorded !== "recorded") {
                  throw new AccountDeletionOperationError("WORKER_UNEXPECTED");
                }
              }
              if (itemFailed) {
                throw new AccountDeletionOperationError("STORAGE_DELETE_FAILED");
              }
              requireHardBudget(rpcTimeoutMs + failureReserveMs);
              const status = await within(
                (signal) => dependencies.advance({
                  requestId: job.id,
                  workerToken,
                  completedPhase: job.phase,
                  prefixScanEmpty: false,
                  signal,
                }),
                rpcTimeoutMs,
                failureReserveMs,
              );
              if (status !== "retry") {
                throw new AccountDeletionOperationError("WORKER_UNEXPECTED");
              }
              advanced += 1;
              continue;
            }

            // A listing may discover paths and therefore require both the
            // registration RPC and the phase-advance RPC before cleanup.
            requireHardBudget(
              storageTimeoutMs + (2 * rpcTimeoutMs) + failureReserveMs,
            );
            let discovered;
            try {
              discovered = await within(
                (signal) => dependencies.listStorage({
                  prefix: job.storage_prefix as string,
                  limit: 4,
                  signal,
                }),
                storageTimeoutMs,
                (2 * rpcTimeoutMs) + failureReserveMs,
              );
            } catch (error) {
              if (error instanceof AccountDeletionTimeoutError) throw error;
              throw new AccountDeletionOperationError("STORAGE_LIST_FAILED");
            }

            if (discovered.length > 0) {
              await within(
                (signal) => dependencies.registerPaths({
                  requestId: job.id,
                  workerToken,
                  paths: discovered,
                  signal,
                }),
                rpcTimeoutMs,
                rpcTimeoutMs + failureReserveMs,
              );
            }
            const status = await within(
              (signal) => dependencies.advance({
                requestId: job.id,
                workerToken,
                completedPhase: job.phase,
                prefixScanEmpty: discovered.length === 0,
                signal,
              }),
              rpcTimeoutMs,
              failureReserveMs,
            );
            if (!["retry", "advanced"].includes(status)) {
              throw new AccountDeletionOperationError("WORKER_UNEXPECTED");
            }
            advanced += 1;
            continue;
          }

          if (job.phase === "auth") {
            for (const authUserId of job.auth_user_ids) {
              if (dependencies.now() >= softDeadline) {
                throw new AccountDeletionOperationError("WORKER_TIMEOUT");
              }
              requireHardBudget(authTimeoutMs + rpcTimeoutMs + failureReserveMs);
              await within(
                (signal) => dependencies.deleteAuthUser({ authUserId, signal }),
                authTimeoutMs,
                rpcTimeoutMs + failureReserveMs,
              );
              const mark = await within(
                (signal) => dependencies.markAuthRemoved({
                  requestId: job.id,
                  workerToken,
                  authUserId,
                  signal,
                }),
                rpcTimeoutMs,
                failureReserveMs,
              );
              if (mark !== "removed" && mark !== "not_found") {
                throw new AccountDeletionOperationError("WORKER_UNEXPECTED");
              }
            }
          }

          const advanceTimeoutMs = job.phase === "database"
            ? Math.max(rpcTimeoutMs, 30_000)
            : rpcTimeoutMs;
          requireHardBudget(advanceTimeoutMs + failureReserveMs);
          const status = await within(
            (signal) => dependencies.advance({
              requestId: job.id,
              workerToken,
              completedPhase: job.phase,
              prefixScanEmpty: false,
              signal,
            }),
            advanceTimeoutMs,
            failureReserveMs,
          );
          if (status === "completed") completed += 1;
          else if (status === "advanced" || status === "retry") advanced += 1;
          else throw new AccountDeletionOperationError("WORKER_UNEXPECTED");
        } catch (error) {
          const errorCode: AccountDeletionWorkerErrorCode = error instanceof AccountDeletionOperationError
            ? error.code
            : error instanceof AccountDeletionTimeoutError
              ? "WORKER_TIMEOUT"
              : defaultErrorCode(job.phase);
          if (errorCode !== "WORKER_UNEXPECTED" && !externalFailureCounted) {
            failedExternalOperations += 1;
          }

          // Failure recording shares the worker hard signal and explicitly
          // preserves the backlog quantum. It can no longer extend execution
          // beyond the route's hard deadline after a late phase timeout.
          const failure = await within(
            (signal) => dependencies.fail({
              requestId: job.id,
              workerToken,
              errorCode,
              signal,
            }),
            FAILURE_RECORD_TIMEOUT_MS,
            backlogReserveMs,
          );
          if (failure === "retrying") retrying += 1;
          else if (failure !== "forbidden") throw new ApiError("INTERNAL");
        }
      }
    }

    const backlogResult = await within(
      (signal) => dependencies.backlog(signal),
      rpcTimeoutMs,
      hardBudgetMarginMs,
    );
    const backlog = publicBacklog(backlogResult);
    return {
      leased,
      advanced,
      completed,
      retrying,
      failed_external_operations: failedExternalOperations,
      backlog,
    };
  } catch {
    throw new ApiError("INTERNAL");
  } finally {
    clearTimeout(hardTimer);
    hardController.abort();
  }
}

function publicBacklog(
  result: AccountDeletionBacklog,
): Omit<AccountDeletionBacklog, "status"> {
  return {
    pending_jobs: result.pending_jobs,
    overdue_jobs: result.overdue_jobs,
    high_attempt_jobs: result.high_attempt_jobs,
    max_attempt_count: result.max_attempt_count,
    oldest_requested_at: result.oldest_requested_at,
    retrying_jobs: result.retrying_jobs,
    completed_receipts: result.completed_receipts,
  };
}
