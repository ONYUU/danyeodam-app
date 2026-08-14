import { describe, expect, it, vi } from "vitest";

import { PersonalCardImageValidationError } from "@/server/personal-cards/image";
import {
  cleanupExpiredPersonalCardUploads,
  deletePersonalCard,
  issuePersonalCardUpload,
  promotePersonalCard,
  type PersonalCardServiceDependencies,
} from "@/server/personal-cards/service";
import { PersonalCardStorageError } from "@/server/personal-cards/storage";

const userId = "11111111-1111-4111-8111-111111111111";
const uploadId = "22222222-2222-4222-8222-222222222222";
const acquisitionId = "33333333-3333-4333-8333-333333333333";
const personalCardId = "44444444-4444-4444-8444-444444444444";
const processingToken = "55555555-5555-4555-8555-555555555555";
const tempPath = `${userId}/${uploadId}.jpg`;
const permanentPath = `${userId}/${processingToken}.webp`;
const quotaIssuedAt = "2026-08-12T05:00:00.000Z";
const clientRequestId = "66666666-6666-4666-8666-666666666666";
const emptyBacklog = {
  status: "ready" as const,
  total_pending: 0,
  promotion_expired_pending: 0,
  signed_url_expired_pending: 0,
  permanent_pending: 0,
  overdue_15m: 0,
  oldest_due_at: null,
};

function makeDependencies(
  overrides: Partial<PersonalCardServiceDependencies> = {},
): PersonalCardServiceDependencies {
  return {
    issueUpload: vi.fn(async () => ({
      status: "issued" as const,
      upload_id: uploadId,
      temp_path: tempPath,
      quota_issued_at: quotaIssuedAt,
      replayed: false,
    })),
    createSignedUploadUrl: vi.fn(async () => "https://storage.example/signed-upload"),
    cancelUploadIssue: vi.fn(async () => undefined),
    beginPromotion: vi.fn(async () => ({
      status: "ready" as const,
      upload_id: uploadId,
      user_id: userId,
      temp_path: tempPath,
      permanent_path: permanentPath,
      declared_content_type: "image/jpeg" as const,
      declared_size_bytes: 3,
    })),
    downloadTemporaryObject: vi.fn(async () => Uint8Array.from([0xff, 0xd8, 0xff])),
    deriveImage: vi.fn(async () => Uint8Array.from([1, 2, 3, 4])),
    uploadPermanentObject: vi.fn(async () => undefined),
    completePromotion: vi.fn(async () => ({
      status: "created" as const,
      personal_card_id: personalCardId,
    })),
    confirmPermanentUnreferenced: vi.fn(async () => ({
      status: "unreferenced" as const,
    })),
    releasePromotion: vi.fn(async () => undefined),
    deleteTemporaryObject: vi.fn(async () => undefined),
    deletePermanentObject: vi.fn(async () => undefined),
    markTemporaryDeleted: vi.fn(async () => undefined),
    listExpiryCleanupCandidates: vi.fn(async () => []),
    listCleanupCandidates: vi.fn(async () => []),
    completeTemporaryCleanup: vi.fn(async () => undefined),
    claimStorageCleanup: vi.fn(async () => null),
    recordStorageCleanupResult: vi.fn(async () => undefined),
    getStorageCleanupBacklog: vi.fn(async () => emptyBacklog),
    purgeCompletedUploads: vi.fn(async () => 0),
    createProcessingToken: vi.fn(() => processingToken),
    now: Date.now,
    ...overrides,
  };
}

function promotionRequest() {
  return {
    authUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    publicGateOpen: false,
    promotion: {
      acquisition_id: acquisitionId,
      temp_path: tempPath,
      caption: "기억",
    },
  };
}

describe("personal card service", () => {
  it("issues a signed URL only for the server-generated temporary path", async () => {
    const dependencies = makeDependencies();

    await expect(issuePersonalCardUpload({
      authUserId: userId,
      publicGateOpen: false,
      upload: {
        content_type: "image/jpeg",
        size: 123,
        client_request_id: clientRequestId,
      },
    }, dependencies)).resolves.toEqual({
      upload_url: "https://storage.example/signed-upload",
      temp_path: tempPath,
    });
    expect(dependencies.issueUpload).toHaveBeenCalledWith({
      authUserId: userId,
      publicGateOpen: false,
      declaredContentType: "image/jpeg",
      declaredSizeBytes: 123,
      clientRequestId,
    });
    expect(dependencies.createSignedUploadUrl).toHaveBeenCalledWith(tempPath);
    expect(dependencies.cancelUploadIssue).not.toHaveBeenCalled();
  });

  it("cancels the exact untouched DB reservation when signed URL creation fails", async () => {
    const storageError = new Error("signed URL unavailable");
    const dependencies = makeDependencies({
      createSignedUploadUrl: vi.fn(async () => { throw storageError; }),
    });

    await expect(issuePersonalCardUpload({
      authUserId: userId,
      publicGateOpen: false,
      upload: {
        content_type: "image/jpeg",
        size: 123,
        client_request_id: clientRequestId,
      },
    }, dependencies)).rejects.toBe(storageError);

    expect(dependencies.cancelUploadIssue).toHaveBeenCalledWith({
      uploadId,
      quotaIssuedAt,
      signal: expect.any(AbortSignal),
    });
  });

  it("preserves an existing reservation when a replay token issuance fails", async () => {
    const storageError = new Error("signed URL unavailable");
    const dependencies = makeDependencies({
      issueUpload: vi.fn(async () => ({
        status: "issued" as const,
        upload_id: uploadId,
        temp_path: tempPath,
        quota_issued_at: quotaIssuedAt,
        replayed: true,
      })),
      createSignedUploadUrl: vi.fn(async () => { throw storageError; }),
    });

    await expect(issuePersonalCardUpload({
      authUserId: userId,
      publicGateOpen: false,
      upload: {
        content_type: "image/jpeg",
        size: 123,
        client_request_id: clientRequestId,
      },
    }, dependencies)).rejects.toBe(storageError);

    expect(dependencies.cancelUploadIssue).not.toHaveBeenCalled();
  });

  it("maps conflicting logical upload-key reuse to 409", async () => {
    const dependencies = makeDependencies({
      issueUpload: vi.fn(async () => ({ status: "idempotency_conflict" as const })),
    });

    await expect(issuePersonalCardUpload({
      authUserId: userId,
      publicGateOpen: false,
      upload: {
        content_type: "image/webp",
        size: 321,
        client_request_id: clientRequestId,
      },
    }, dependencies)).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      status: 409,
    });
    expect(dependencies.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("returns the exact accepted delete receipt and forwards its logical key", async () => {
    const requestDeletion = vi.fn(async () => ({ status: "accepted" as const }));

    await expect(deletePersonalCard({
      authUserId: userId,
      personalCardId,
      clientRequestId,
    }, requestDeletion)).resolves.toEqual({ status: "accepted" });
    expect(requestDeletion).toHaveBeenCalledWith({
      authUserId: userId,
      personalCardId,
      clientRequestId,
    });
  });

  it.each([
    ["not_found", "NOT_FOUND", 404],
    ["idempotency_conflict", "IDEMPOTENCY_CONFLICT", 409],
  ] as const)("maps delete %s without leaking card ownership", async (
    status,
    code,
    httpStatus,
  ) => {
    const requestDeletion = vi.fn(async () => ({ status }));

    await expect(deletePersonalCard({
      authUserId: userId,
      personalCardId,
      clientRequestId,
    }, requestDeletion)).rejects.toMatchObject({ code, status: httpStatus });
  });

  it("enforces the participant gate result before asking Storage for a URL", async () => {
    const dependencies = makeDependencies({
      issueUpload: vi.fn(async () => ({ status: "gate_closed" as const })),
    });

    await expect(issuePersonalCardUpload({
      authUserId: userId,
      publicGateOpen: false,
      upload: {
        content_type: "image/jpeg",
        size: 123,
        client_request_id: clientRequestId,
      },
    }, dependencies)).rejects.toMatchObject({ code: "GATE_CLOSED", status: 403 });
    expect(dependencies.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("requires current UGC policy acceptance before issuing a photo upload URL", async () => {
    const dependencies = makeDependencies({
      issueUpload: vi.fn(async () => ({
        status: "policy_required" as const,
        required: [
          { type: "terms_of_use" as const, version: "1.0" },
          { type: "community_guidelines" as const, version: "1.0" },
        ],
      })),
    });

    await expect(issuePersonalCardUpload({
      authUserId: userId,
      publicGateOpen: false,
      upload: {
        content_type: "image/jpeg",
        size: 123,
        client_request_id: clientRequestId,
      },
    }, dependencies)).rejects.toMatchObject({
      code: "POLICY_ACCEPTANCE_REQUIRED",
      status: 428,
      details: { required: expect.any(Array) },
    });
    expect(dependencies.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("maps the database upload rate limit before asking Storage for a URL", async () => {
    const dependencies = makeDependencies({
      issueUpload: vi.fn(async () => ({
        status: "rate_limited" as const,
        retry_after_seconds: 37,
      })),
    });

    await expect(issuePersonalCardUpload({
      authUserId: userId,
      publicGateOpen: false,
      upload: {
        content_type: "image/jpeg",
        size: 123,
        client_request_id: clientRequestId,
      },
    }, dependencies)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
      details: { retry_after_seconds: 37 },
    });
    expect(dependencies.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("maps an active temporary-upload quota before asking Storage for a URL", async () => {
    const dependencies = makeDependencies({
      issueUpload: vi.fn(async () => ({
        status: "quota_exceeded" as const,
        reason: "active_temp_uploads" as const,
      })),
    });

    await expect(issuePersonalCardUpload({
      authUserId: userId,
      publicGateOpen: false,
      upload: {
        content_type: "image/jpeg",
        size: 123,
        client_request_id: clientRequestId,
      },
    }, dependencies)).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
      status: 409,
      details: { reason: "active_temp_uploads" },
    });
    expect(dependencies.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("requires current UGC policy acceptance again at promotion entry", async () => {
    const dependencies = makeDependencies({
      beginPromotion: vi.fn(async () => ({
        status: "policy_required" as const,
        required: [
          { type: "terms_of_use" as const, version: "1.1" },
          { type: "community_guidelines" as const, version: "1.1" },
        ],
      })),
    });

    await expect(promotePersonalCard(promotionRequest(), dependencies)).rejects.toMatchObject({
      code: "POLICY_ACCEPTANCE_REQUIRED",
      status: 428,
    });
    expect(dependencies.downloadTemporaryObject).not.toHaveBeenCalled();
  });

  it.each(["storage_bytes", "permanent_object_backlog"] as const)(
    "maps a %s quota rejection at promotion entry before Storage I/O",
    async (reason) => {
      const dependencies = makeDependencies({
        beginPromotion: vi.fn(async () => ({
          status: "quota_exceeded" as const,
          reason,
        })),
      });

      await expect(promotePersonalCard(promotionRequest(), dependencies)).rejects.toMatchObject({
        code: "QUOTA_EXCEEDED",
        status: 409,
        details: { reason },
      });
      expect(dependencies.downloadTemporaryObject).not.toHaveBeenCalled();
      expect(dependencies.uploadPermanentObject).not.toHaveBeenCalled();
    },
  );

  it("promotes only the derived image, completes DB state, then removes temp", async () => {
    const dependencies = makeDependencies();

    await expect(promotePersonalCard(promotionRequest(), dependencies)).resolves.toEqual({
      personal_card: { id: personalCardId, share_slug: null },
    });
    expect(dependencies.deriveImage).toHaveBeenCalledWith({
      bytes: Uint8Array.from([0xff, 0xd8, 0xff]),
      declaredContentType: "image/jpeg",
      declaredSizeBytes: 3,
    });
    expect(dependencies.uploadPermanentObject).toHaveBeenCalledWith(
      permanentPath,
      Uint8Array.from([1, 2, 3, 4]),
    );
    expect(dependencies.completePromotion).toHaveBeenCalledWith({
      authUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      uploadId,
      processingToken,
      acquisitionId,
      permanentPath,
      caption: "기억",
      photoSizeBytes: 4,
      expectedUserId: userId,
    });
    expect(dependencies.deleteTemporaryObject).toHaveBeenCalledWith(tempPath);
    expect(dependencies.markTemporaryDeleted).toHaveBeenCalledWith({ uploadId });
    expect(dependencies.releasePromotion).not.toHaveBeenCalled();
  });

  it("returns an existing completed card without touching Storage", async () => {
    const dependencies = makeDependencies({
      beginPromotion: vi.fn(async () => ({
        status: "already_created" as const,
        personal_card_id: personalCardId,
      })),
    });

    await expect(promotePersonalCard(promotionRequest(), dependencies)).resolves.toEqual({
      personal_card: { id: personalCardId, share_slug: null },
    });
    expect(dependencies.downloadTemporaryObject).not.toHaveBeenCalled();
    expect(dependencies.uploadPermanentObject).not.toHaveBeenCalled();
  });

  it("fails closed when a DB result attempts to redirect Storage paths", async () => {
    const dependencies = makeDependencies({
      beginPromotion: vi.fn(async () => ({
        status: "ready" as const,
        upload_id: uploadId,
        user_id: userId,
        temp_path: tempPath,
        permanent_path: "99999999-9999-4999-8999-999999999999/stolen.webp",
        declared_content_type: "image/jpeg" as const,
        declared_size_bytes: 3,
      })),
    });

    await expect(promotePersonalCard(promotionRequest(), dependencies)).rejects.toMatchObject({
      code: "INTERNAL",
      status: 500,
    });
    expect(dependencies.releasePromotion).toHaveBeenCalledWith({ uploadId, processingToken });
    expect(dependencies.downloadTemporaryObject).not.toHaveBeenCalled();
  });

  it("deletes an invalid temporary object and releases its processing lease", async () => {
    const dependencies = makeDependencies({
      deriveImage: vi.fn(async () => {
        throw new PersonalCardImageValidationError();
      }),
    });

    await expect(promotePersonalCard(promotionRequest(), dependencies)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 400,
    });
    expect(dependencies.deleteTemporaryObject).toHaveBeenCalledWith(tempPath);
    expect(dependencies.markTemporaryDeleted).toHaveBeenCalledWith({ uploadId });
    expect(dependencies.releasePromotion).toHaveBeenCalledWith({ uploadId, processingToken });
    expect(dependencies.uploadPermanentObject).not.toHaveBeenCalled();
  });

  it("maps a missing temporary object to 404 and still leaves cleanup state retryable", async () => {
    const dependencies = makeDependencies({
      downloadTemporaryObject: vi.fn(async () => {
        throw new PersonalCardStorageError("not_found");
      }),
    });

    await expect(promotePersonalCard(promotionRequest(), dependencies)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    expect(dependencies.deleteTemporaryObject).toHaveBeenCalledWith(tempPath);
    expect(dependencies.markTemporaryDeleted).toHaveBeenCalledWith({ uploadId });
    expect(dependencies.releasePromotion).toHaveBeenCalledWith({ uploadId, processingToken });
  });

  it("preserves the permanent object when the DB completion response is ambiguous", async () => {
    let databaseCommitted = false;
    const dependencies = makeDependencies({
      completePromotion: vi.fn(async () => {
        databaseCommitted = true;
        throw new Error("response lost after commit");
      }),
    });

    await expect(promotePersonalCard(promotionRequest(), dependencies)).rejects.toThrow(
      "response lost after commit",
    );
    expect(databaseCommitted).toBe(true);
    expect(dependencies.confirmPermanentUnreferenced).not.toHaveBeenCalled();
    expect(dependencies.deletePermanentObject).not.toHaveBeenCalled();
    expect(dependencies.releasePromotion).toHaveBeenCalledWith({ uploadId, processingToken });
    expect(dependencies.deleteTemporaryObject).not.toHaveBeenCalled();
  });

  it("deletes only an explicit DB-confirmed unreferenced permanent object", async () => {
    const dependencies = makeDependencies({
      completePromotion: vi.fn(async () => ({ status: "stale" as const })),
    });

    await expect(promotePersonalCard(promotionRequest(), dependencies)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 400,
    });
    expect(dependencies.confirmPermanentUnreferenced).toHaveBeenCalledWith({
      uploadId,
      processingToken,
      permanentPath,
    });
    expect(dependencies.deletePermanentObject).toHaveBeenCalledWith(permanentPath);
    expect(dependencies.releasePromotion).toHaveBeenCalledWith({ uploadId, processingToken });
  });

  it("removes an unreferenced derived object when DB storage quota is exceeded", async () => {
    const dependencies = makeDependencies({
      completePromotion: vi.fn(async () => ({
        status: "quota_exceeded" as const,
        reason: "storage_bytes" as const,
      })),
    });

    await expect(promotePersonalCard(promotionRequest(), dependencies)).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
      status: 409,
      details: { reason: "storage_bytes" },
    });
    expect(dependencies.confirmPermanentUnreferenced).toHaveBeenCalledWith({
      uploadId,
      processingToken,
      permanentPath,
    });
    expect(dependencies.deletePermanentObject).toHaveBeenCalledWith(permanentPath);
    expect(dependencies.releasePromotion).toHaveBeenCalledWith({ uploadId, processingToken });
  });

  it.each(["referenced", "unknown"] as const)(
    "preserves the permanent object when the DB reports it as %s",
    async (status) => {
      const dependencies = makeDependencies({
        completePromotion: vi.fn(async () => ({ status: "expired" as const })),
        confirmPermanentUnreferenced: vi.fn(async () => ({ status })),
      });

      await expect(promotePersonalCard(promotionRequest(), dependencies)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        status: 400,
      });
      expect(dependencies.deletePermanentObject).not.toHaveBeenCalled();
    },
  );

  it("preserves the permanent object when the reference check itself is ambiguous", async () => {
    const dependencies = makeDependencies({
      completePromotion: vi.fn(async () => ({ status: "stale" as const })),
      confirmPermanentUnreferenced: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    });

    await expect(promotePersonalCard(promotionRequest(), dependencies)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 400,
    });
    expect(dependencies.deletePermanentObject).not.toHaveBeenCalled();
  });

  it("keeps the temp object retryable when permanent Storage upload fails", async () => {
    const dependencies = makeDependencies({
      uploadPermanentObject: vi.fn(async () => {
        throw new PersonalCardStorageError("internal");
      }),
    });

    await expect(promotePersonalCard(promotionRequest(), dependencies)).rejects.toBeInstanceOf(
      PersonalCardStorageError,
    );
    expect(dependencies.releasePromotion).toHaveBeenCalledWith({ uploadId, processingToken });
    expect(dependencies.deleteTemporaryObject).not.toHaveBeenCalled();
    expect(dependencies.completePromotion).not.toHaveBeenCalled();
  });

  it("processes the oldest unified queue one row at a time so final cleanup progresses", async () => {
    const secondUploadId = "66666666-6666-4666-8666-666666666666";
    const secondPath = `${userId}/${secondUploadId}.png`;
    const finalUploadId = "77777777-7777-4777-8777-777777777777";
    const finalPath = `${userId}/${finalUploadId}.webp`;
    let nowMs = 0;
    const claims = [
      {
        kind: "temporary" as const,
        upload_id: uploadId,
        path: tempPath,
        phase: "promotion_expired" as const,
      },
      {
        kind: "temporary" as const,
        upload_id: finalUploadId,
        path: finalPath,
        phase: "signed_url_expired" as const,
      },
      {
        kind: "temporary" as const,
        upload_id: secondUploadId,
        path: secondPath,
        phase: "promotion_expired" as const,
      },
    ];
    const claimStorageCleanup = vi.fn(async () => {
      nowMs += 4_000;
      return claims.shift() ?? null;
    });
    const deleteTemporaryObject = vi.fn(async (
      _path: string,
      _signal?: AbortSignal,
    ) => {
      void _path;
      void _signal;
      nowMs += 5_000;
    });
    const recordStorageCleanupResult = vi.fn(async () => {
      nowMs += 4_000;
    });
    const getStorageCleanupBacklog = vi.fn(async () => {
      nowMs += 4_000;
      return {
        ...emptyBacklog,
        total_pending: 7,
        promotion_expired_pending: 6,
        oldest_due_at: "2026-08-12T04:00:00.000Z",
      };
    });
    const dependencies = makeDependencies({
      now: () => nowMs,
      claimStorageCleanup,
      deleteTemporaryObject,
      recordStorageCleanupResult,
      getStorageCleanupBacklog,
    });

    await expect(cleanupExpiredPersonalCardUploads({}, dependencies)).resolves.toEqual({
      promotion_expired: { processed: 2, failed: 0 },
      signed_url_expired: { processed: 1, failed: 0 },
      permanent: { processed: 0, failed: 0 },
      backlog: {
        ...emptyBacklog,
        total_pending: 7,
        promotion_expired_pending: 6,
        oldest_due_at: "2026-08-12T04:00:00.000Z",
      },
    });
    expect(claimStorageCleanup).toHaveBeenCalledTimes(3);
    expect(deleteTemporaryObject.mock.calls.map(([path]) => path)).toEqual([
      tempPath,
      finalPath,
      secondPath,
    ]);
    expect(recordStorageCleanupResult).toHaveBeenCalledTimes(3);
    expect(claims).toHaveLength(0);
  });

  it("does not claim a row when the remaining hard budget cannot cover one full quantum", async () => {
    const dependencies = makeDependencies();

    await expect(cleanupExpiredPersonalCardUploads({
      softRuntimeMs: 1_000,
      hardRuntimeMs: 15_000,
    }, dependencies)).resolves.toEqual({
      promotion_expired: { processed: 0, failed: 0 },
      signed_url_expired: { processed: 0, failed: 0 },
      permanent: { processed: 0, failed: 0 },
      backlog: emptyBacklog,
    });
    expect(dependencies.claimStorageCleanup).not.toHaveBeenCalled();
    expect(dependencies.getStorageCleanupBacklog).toHaveBeenCalledOnce();
  });

  it("records a failed permanent delete and keeps it retryable", async () => {
    const ledgerItem = {
      kind: "permanent" as const,
      ledger_id: "42",
      path: permanentPath,
      phase: "final" as const,
    };
    const claimStorageCleanup = vi
      .fn()
      .mockResolvedValueOnce(ledgerItem)
      .mockResolvedValueOnce(null);
    const dependencies = makeDependencies({
      claimStorageCleanup,
      deletePermanentObject: vi.fn(async () => {
        throw new PersonalCardStorageError("internal");
      }),
    });

    await expect(cleanupExpiredPersonalCardUploads({}, dependencies)).resolves.toEqual({
      promotion_expired: { processed: 0, failed: 0 },
      signed_url_expired: { processed: 0, failed: 0 },
      permanent: { processed: 0, failed: 1 },
      backlog: emptyBacklog,
    });
    expect(dependencies.recordStorageCleanupResult).toHaveBeenCalledWith({
      workerToken: processingToken,
      item: ledgerItem,
      deleted: false,
      signal: expect.any(AbortSignal),
    });
  });
});
