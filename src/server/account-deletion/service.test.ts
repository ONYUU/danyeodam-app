import { describe, expect, it, vi } from "vitest";

import {
  isMissingAuthUserError,
  processAccountDeletionJobs,
  type AccountDeletionWorkerDependencies,
} from "@/server/account-deletion/service";

const requestId = "11111111-1111-4111-8111-111111111111";
const workerToken = "22222222-2222-4222-8222-222222222222";
const prefix = "33333333-3333-4333-8333-333333333333";

const backlog = {
  status: "ready" as const,
  pending_jobs: 1,
  overdue_jobs: 0,
  high_attempt_jobs: 0,
  max_attempt_count: 1,
  oldest_requested_at: "2026-08-12T00:00:00.000Z",
  retrying_jobs: 0,
  completed_receipts: 0,
};

function dependencies(): AccountDeletionWorkerDependencies & Record<
  "claim" | "listStorage" | "deleteStorage" | "registerPaths" | "recordStorage"
  | "deleteAuthUser" | "markAuthRemoved" | "advance" | "fail" | "backlog",
  ReturnType<typeof vi.fn>
> {
  return {
    createWorkerToken: () => workerToken,
    now: Date.now,
    claim: vi.fn(async () => []),
    listStorage: vi.fn(async () => []),
    deleteStorage: vi.fn(async () => true),
    registerPaths: vi.fn(async () => undefined),
    recordStorage: vi.fn(async () => "recorded" as const),
    deleteAuthUser: vi.fn(async () => undefined),
    markAuthRemoved: vi.fn(async () => "removed" as const),
    advance: vi.fn(async () => "advanced" as const),
    fail: vi.fn(async () => "retrying" as const),
    backlog: vi.fn(async () => backlog),
  };
}

describe("account deletion worker", () => {
  it("accepts only the exact Auth user-not-found code as idempotent deletion", () => {
    expect(isMissingAuthUserError({ status: 404, code: "user_not_found" })).toBe(true);
    expect(isMissingAuthUserError({ status: 404, code: "route_not_found" })).toBe(false);
    expect(isMissingAuthUserError({ status: 404 })).toBe(false);
    expect(isMissingAuthUserError(new Error("not found"))).toBe(false);
  });

  it("deletes a bounded manifest item and keeps the phase for a later prefix scan", async () => {
    const deps = dependencies();
    deps.claim.mockResolvedValueOnce([{
      id: requestId,
      phase: "storage_initial",
      storage_prefix: prefix,
      storage_items: [{
        id: 1,
        bucket: "personal-cards",
        object_path: `${prefix}/card.webp`,
        pass: "first",
      }],
      auth_user_ids: [],
    }]).mockResolvedValue([]);
    deps.advance.mockResolvedValue("retry");

    const result = await processAccountDeletionJobs({}, deps);

    expect(result).toMatchObject({ leased: 1, advanced: 1, retrying: 0 });
    expect(deps.deleteStorage).toHaveBeenCalledWith({
      bucket: "personal-cards",
      objectPath: `${prefix}/card.webp`,
      signal: expect.any(AbortSignal),
    });
    expect(deps.recordStorage).toHaveBeenCalledWith({
      requestId,
      workerToken,
      itemId: 1,
      pass: "first",
      deleted: true,
      signal: expect.any(AbortSignal),
    });
    expect(deps.advance).toHaveBeenCalledWith(expect.objectContaining({
      requestId,
      completedPhase: "storage_initial",
      prefixScanEmpty: false,
    }));
  });

  it("registers objects discovered after the request snapshot before advancing", async () => {
    const deps = dependencies();
    deps.claim.mockResolvedValueOnce([{
      id: requestId,
      phase: "storage_final",
      storage_prefix: prefix,
      storage_items: [],
      auth_user_ids: [],
    }]).mockResolvedValue([]);
    deps.listStorage.mockResolvedValue([{
      bucket: "personal-card-temp",
      object_path: `${prefix}/late.webp`,
    }]);
    deps.advance.mockResolvedValue("retry");

    await processAccountDeletionJobs({}, deps);

    expect(deps.registerPaths).toHaveBeenCalledWith(expect.objectContaining({
      requestId,
      paths: [{
        bucket: "personal-card-temp",
        object_path: `${prefix}/late.webp`,
      }],
    }));
    expect(deps.advance).toHaveBeenCalledWith(expect.objectContaining({
      prefixScanEmpty: false,
    }));
  });

  it("advances only after both owned Storage prefixes are empty", async () => {
    const deps = dependencies();
    deps.claim.mockResolvedValueOnce([{
      id: requestId,
      phase: "storage_final",
      storage_prefix: prefix,
      storage_items: [],
      auth_user_ids: [],
    }]).mockResolvedValue([]);
    deps.advance.mockResolvedValue("advanced");

    await processAccountDeletionJobs({}, deps);

    expect(deps.listStorage).toHaveBeenCalledWith({
      prefix,
      limit: 4,
      signal: expect.any(AbortSignal),
    });
    expect(deps.advance).toHaveBeenCalledWith(expect.objectContaining({
      prefixScanEmpty: true,
    }));
  });

  it("hard-deletes every offered Auth identity and records each idempotently", async () => {
    const deps = dependencies();
    const authUserIds = [
      "44444444-4444-4444-8444-444444444444",
      "55555555-5555-4555-8555-555555555555",
    ];
    deps.claim.mockResolvedValueOnce([{
      id: requestId,
      phase: "auth",
      storage_prefix: prefix,
      storage_items: [],
      auth_user_ids: authUserIds,
    }]).mockResolvedValue([]);

    await processAccountDeletionJobs({}, deps);

    expect(deps.deleteAuthUser).toHaveBeenCalledTimes(2);
    expect(deps.markAuthRemoved).toHaveBeenCalledTimes(2);
    expect(deps.advance).toHaveBeenCalledWith(expect.objectContaining({
      completedPhase: "auth",
    }));
  });

  it("records only a fixed failure code and leaves Storage deletion retryable", async () => {
    const deps = dependencies();
    deps.claim.mockResolvedValueOnce([{
      id: requestId,
      phase: "storage_final",
      storage_prefix: prefix,
      storage_items: [{
        id: 1,
        bucket: "personal-cards",
        object_path: `${prefix}/secret.webp`,
        pass: "final",
      }],
      auth_user_ids: [],
    }]).mockResolvedValue([]);
    deps.deleteStorage.mockResolvedValue(false);
    deps.recordStorage.mockResolvedValue("retry");

    const result = await processAccountDeletionJobs({}, deps);

    expect(result.retrying).toBe(1);
    expect(result.failed_external_operations).toBe(1);
    expect(deps.fail).toHaveBeenCalledWith({
      requestId,
      workerToken,
      errorCode: "STORAGE_DELETE_FAILED",
      signal: expect.any(AbortSignal),
    });
    expect(JSON.stringify(deps.fail.mock.calls)).not.toContain("secret.webp");
  });

  it("times out a dependency that ignores abort and records a bounded retry", async () => {
    const deps = dependencies();
    deps.now = () => 0;
    deps.claim.mockResolvedValueOnce([{
      id: requestId,
      phase: "storage_initial",
      storage_prefix: prefix,
      storage_items: [{
        id: 1,
        bucket: "personal-cards",
        object_path: `${prefix}/stalled.webp`,
        pass: "first",
      }],
      auth_user_ids: [],
    }]).mockResolvedValue([]);
    deps.deleteStorage.mockImplementation(() => new Promise<boolean>(() => undefined));

    const result = await processAccountDeletionJobs({
      softRuntimeMs: 100,
      hardRuntimeMs: 3_000,
      rpcTimeoutMs: 20,
      storageTimeoutMs: 20,
    }, deps);

    expect(result.retrying).toBe(1);
    expect(deps.fail).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "WORKER_TIMEOUT",
    }));
  });

  it("does not claim a new lease when only the hard-deadline tail remains", async () => {
    const deps = dependencies();
    deps.now = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValue(44_000);

    const result = await processAccountDeletionJobs({}, deps);

    expect(result).toMatchObject({ leased: 0, advanced: 0, retrying: 0 });
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.backlog).toHaveBeenCalledTimes(1);
  });

  it("fails a claimed phase before external I/O when its full quantum no longer fits", async () => {
    const deps = dependencies();
    let now = 0;
    deps.now = () => now;
    deps.claim.mockImplementationOnce(async () => {
      now = 38_000;
      return [{
        id: requestId,
        phase: "storage_initial" as const,
        storage_prefix: prefix,
        storage_items: [{
          id: 1,
          bucket: "personal-cards" as const,
          object_path: `${prefix}/too-late.webp`,
          pass: "first" as const,
        }],
        auth_user_ids: [],
      }];
    }).mockResolvedValue([]);

    const result = await processAccountDeletionJobs({}, deps);

    expect(result).toMatchObject({ leased: 1, advanced: 0, retrying: 1 });
    expect(deps.deleteStorage).not.toHaveBeenCalled();
    expect(deps.recordStorage).not.toHaveBeenCalled();
    expect(deps.advance).not.toHaveBeenCalled();
    expect(deps.fail).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "WORKER_TIMEOUT",
    }));
    expect(deps.backlog).toHaveBeenCalledTimes(1);
  });

  it("reserves Auth deletion, removal marking, failure, and backlog as one quantum", async () => {
    const deps = dependencies();
    let now = 0;
    deps.now = () => now;
    deps.claim.mockImplementationOnce(async () => {
      now = 30_000;
      return [{
        id: requestId,
        phase: "auth" as const,
        storage_prefix: null,
        storage_items: [],
        auth_user_ids: ["44444444-4444-4444-8444-444444444444"],
      }];
    }).mockResolvedValue([]);

    const result = await processAccountDeletionJobs({}, deps);

    expect(result).toMatchObject({ leased: 1, advanced: 0, retrying: 1 });
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
    expect(deps.markAuthRemoved).not.toHaveBeenCalled();
    expect(deps.fail).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "WORKER_TIMEOUT",
    }));
  });

  it("caps failure recording to the hard budget left after a late phase error", async () => {
    vi.useFakeTimers();
    try {
      const deps = dependencies();
      let now = 0;
      let failureSignal: AbortSignal | undefined;
      deps.now = () => now;
      deps.claim.mockResolvedValueOnce([{
        id: requestId,
        phase: "storage_initial",
        storage_prefix: prefix,
        storage_items: [{
          id: 1,
          bucket: "personal-cards",
          object_path: `${prefix}/late-failure.webp`,
          pass: "first",
        }],
        auth_user_ids: [],
      }]);
      deps.deleteStorage.mockImplementation(async () => {
        now = 42_500;
        throw new Error("late Storage failure");
      });
      deps.fail.mockImplementation(({ signal }) => {
        failureSignal = signal;
        return new Promise(() => undefined);
      });

      const outcome = processAccountDeletionJobs({}, deps);
      const rejection = expect(outcome).rejects.toMatchObject({ code: "INTERNAL" });
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.fail).toHaveBeenCalledTimes(1);

      // 48s hard - 42.5s elapsed - 4s backlog - 250ms margin.
      await vi.advanceTimersByTimeAsync(1_250);
      await rejection;
      expect(failureSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps the final backlog read to the remaining hard deadline", async () => {
    vi.useFakeTimers();
    try {
      const deps = dependencies();
      deps.now = () => 0;
      let backlogSignal: AbortSignal | undefined;
      deps.backlog.mockImplementation((signal) => {
        backlogSignal = signal;
        return new Promise(() => undefined);
      });

      const outcome = processAccountDeletionJobs({
        softRuntimeMs: 50,
        hardRuntimeMs: 100,
      }, deps);
      const rejection = expect(outcome).rejects.toMatchObject({ code: "INTERNAL" });

      // The 1ms scaled safety margin makes the backlog timeout 99ms.
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      expect(deps.claim).not.toHaveBeenCalled();
      expect(backlogSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains immediately eligible phases within one bounded invocation", async () => {
    const deps = dependencies();
    let leaseGeneration = 0;
    deps.createWorkerToken = () => `lease-generation-${leaseGeneration++}`;
    const phases = [
      "storage_initial",
      "storage_final",
      "database",
      "auth",
      "finalize",
    ] as const;
    for (const phase of phases) {
      deps.claim.mockResolvedValueOnce([{
        id: requestId,
        phase,
        storage_prefix: phase.startsWith("storage") ? prefix : null,
        storage_items: [],
        auth_user_ids: [],
      }]);
    }
    deps.claim.mockResolvedValueOnce([]);
    deps.advance
      .mockResolvedValueOnce("advanced")
      .mockResolvedValueOnce("advanced")
      .mockResolvedValueOnce("advanced")
      .mockResolvedValueOnce("advanced")
      .mockResolvedValueOnce("completed");

    const result = await processAccountDeletionJobs({}, deps);

    expect(result).toMatchObject({
      leased: 5,
      advanced: 4,
      completed: 1,
      retrying: 0,
    });
    expect(deps.claim).toHaveBeenCalledTimes(6);
    expect(new Set(
      deps.claim.mock.calls.map(([input]) => input.workerToken),
    ).size).toBe(6);
    expect(deps.advance.mock.calls.map(([input]) => input.completedPhase))
      .toEqual(phases);
  });
});
