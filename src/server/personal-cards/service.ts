import "server-only";

import { randomUUID } from "node:crypto";

import { ApiError } from "@/server/http/api-error";
import {
  PersonalCardImageValidationError,
  validateAndDerivePersonalCardImage,
} from "@/server/personal-cards/image";
import type {
  PersonalCardContentType,
  PersonalCardPromotionInput,
  PersonalCardUploadInput,
} from "@/server/personal-cards/input";
import {
  beginPersonalCardPromotion,
  cancelPersonalCardTemporaryUploadIssue,
  completePersonalCardPromotion,
  completePersonalCardTemporaryCleanup,
  claimPersonalCardStorageCleanup,
  confirmPersonalCardPermanentUnreferenced,
  getPersonalCardStorageCleanupBacklog,
  issuePersonalCardTemporaryUpload,
  listPersonalCardCleanupCandidates,
  listPersonalCardExpiryCleanupCandidates,
  markPersonalCardTemporaryObjectDeleted,
  purgeCompletedPersonalCardUploads,
  recordPersonalCardStorageCleanupResult,
  releasePersonalCardPromotion,
  requestPersonalCardDeletion,
  type BeginPromotionResult,
  type CleanupCandidate,
  type CompletePromotionResult,
  type IssueUploadResult,
  type PermanentReferenceResult,
  type StorageCleanupBacklog,
  type StorageCleanupItem,
} from "@/server/personal-cards/repository";
import {
  createPersonalCardSignedUploadUrl,
  deletePersonalCardPermanentObject,
  deletePersonalCardTemporaryObject,
  downloadPersonalCardTemporaryObject,
  PersonalCardStorageError,
  uploadPersonalCardPermanentObject,
} from "@/server/personal-cards/storage";

export type PersonalCardServiceDependencies = {
  issueUpload(input: {
    authUserId: string;
    publicGateOpen: boolean;
    declaredContentType: PersonalCardContentType;
    declaredSizeBytes: number;
    clientRequestId: string;
  }): Promise<IssueUploadResult>;
  createSignedUploadUrl(tempPath: string): Promise<string>;
  cancelUploadIssue(input: {
    uploadId: string;
    quotaIssuedAt: string;
    signal: AbortSignal;
  }): Promise<void>;
  beginPromotion(input: {
    authUserId: string;
    publicGateOpen: boolean;
    acquisitionId: string;
    tempPath: string;
    caption: string;
    processingToken: string;
  }): Promise<BeginPromotionResult>;
  downloadTemporaryObject(tempPath: string): Promise<Uint8Array>;
  deriveImage(input: {
    bytes: Uint8Array;
    declaredContentType: PersonalCardContentType;
    declaredSizeBytes: number;
  }): Promise<Uint8Array>;
  uploadPermanentObject(permanentPath: string, bytes: Uint8Array): Promise<void>;
  completePromotion(input: {
    authUserId: string;
    uploadId: string;
    processingToken: string;
    acquisitionId: string;
    permanentPath: string;
    caption: string;
    photoSizeBytes: number;
    expectedUserId: string;
  }): Promise<CompletePromotionResult>;
  confirmPermanentUnreferenced(input: {
    uploadId: string;
    processingToken: string;
    permanentPath: string;
  }): Promise<PermanentReferenceResult>;
  releasePromotion(input: { uploadId: string; processingToken: string }): Promise<void>;
  deleteTemporaryObject(tempPath: string, signal?: AbortSignal): Promise<void>;
  deletePermanentObject(permanentPath: string, signal?: AbortSignal): Promise<void>;
  markTemporaryDeleted(input: { uploadId: string; signal?: AbortSignal }): Promise<void>;
  listExpiryCleanupCandidates(input: {
    limit: number;
    signal?: AbortSignal;
  }): Promise<CleanupCandidate[]>;
  listCleanupCandidates(input: {
    limit: number;
    signal?: AbortSignal;
  }): Promise<CleanupCandidate[]>;
  completeTemporaryCleanup(input: {
    uploadId: string;
    signal?: AbortSignal;
  }): Promise<void>;
  claimStorageCleanup(input: {
    workerToken: string;
    signal?: AbortSignal;
  }): Promise<StorageCleanupItem | null>;
  recordStorageCleanupResult(input: {
    workerToken: string;
    item: StorageCleanupItem;
    deleted: boolean;
    signal?: AbortSignal;
  }): Promise<void>;
  getStorageCleanupBacklog(input?: {
    signal?: AbortSignal;
  }): Promise<StorageCleanupBacklog>;
  purgeCompletedUploads(input: {
    limit: number;
    signal?: AbortSignal;
  }): Promise<number>;
  createProcessingToken(): string;
  now(): number;
};

const defaultDependencies: PersonalCardServiceDependencies = {
  issueUpload: issuePersonalCardTemporaryUpload,
  createSignedUploadUrl: createPersonalCardSignedUploadUrl,
  cancelUploadIssue: cancelPersonalCardTemporaryUploadIssue,
  beginPromotion: beginPersonalCardPromotion,
  downloadTemporaryObject: downloadPersonalCardTemporaryObject,
  deriveImage: validateAndDerivePersonalCardImage,
  uploadPermanentObject: uploadPersonalCardPermanentObject,
  completePromotion: completePersonalCardPromotion,
  confirmPermanentUnreferenced: confirmPersonalCardPermanentUnreferenced,
  releasePromotion: releasePersonalCardPromotion,
  deleteTemporaryObject: deletePersonalCardTemporaryObject,
  deletePermanentObject: deletePersonalCardPermanentObject,
  markTemporaryDeleted: markPersonalCardTemporaryObjectDeleted,
  listExpiryCleanupCandidates: listPersonalCardExpiryCleanupCandidates,
  listCleanupCandidates: listPersonalCardCleanupCandidates,
  completeTemporaryCleanup: completePersonalCardTemporaryCleanup,
  claimStorageCleanup: claimPersonalCardStorageCleanup,
  recordStorageCleanupResult: recordPersonalCardStorageCleanupResult,
  getStorageCleanupBacklog: getPersonalCardStorageCleanupBacklog,
  purgeCompletedUploads: purgeCompletedPersonalCardUploads,
  createProcessingToken: randomUUID,
  now: Date.now,
};

async function bestEffort(action: () => Promise<void>): Promise<boolean> {
  try {
    await action();
    return true;
  } catch {
    return false;
  }
}

async function bestEffortWithin(
  action: (signal: AbortSignal) => Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let removeListener: () => void = () => {};
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(new Error("best-effort operation timed out"));
      if (controller.signal.aborted) return onAbort();
      controller.signal.addEventListener("abort", onAbort, { once: true });
      removeListener = () => controller.signal.removeEventListener("abort", onAbort);
    });
    await Promise.race([action(controller.signal), aborted]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    removeListener();
  }
}

async function runWithin<T>(
  action: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = AbortSignal.any([parentSignal, controller.signal]);
  let removeListener: () => void = () => {};
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(new Error("maintenance operation timed out"));
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      removeListener = () => signal.removeEventListener("abort", onAbort);
    });
    return await Promise.race([action(signal), aborted]);
  } finally {
    clearTimeout(timer);
    removeListener();
  }
}

function throwIssueError(result: Exclude<IssueUploadResult, { status: "issued" }>): never {
  switch (result.status) {
    case "unauthorized":
      throw new ApiError("UNAUTHORIZED");
    case "gate_closed":
      throw new ApiError("GATE_CLOSED");
    case "policy_required":
      throw new ApiError("POLICY_ACCEPTANCE_REQUIRED", { required: result.required });
    case "validation_failed":
      throw new ApiError("VALIDATION_FAILED");
    case "idempotency_conflict":
      throw new ApiError("IDEMPOTENCY_CONFLICT");
    case "rate_limited":
      throw new ApiError("RATE_LIMITED", {
        retry_after_seconds: result.retry_after_seconds,
      });
    case "quota_exceeded":
      throw new ApiError("QUOTA_EXCEEDED", { reason: result.reason });
    case "minimum_age_attestation_required":
      throw new ApiError("MINIMUM_AGE_ATTESTATION_REQUIRED");
    case "location_consent_required":
      throw new ApiError("LOCATION_CONSENT_REQUIRED");
    case "location_use_paused":
      throw new ApiError("LOCATION_USE_PAUSED");
    case "location_withdrawal_pending":
      throw new ApiError("LOCATION_WITHDRAWAL_PENDING");
  }
}

function throwBeginError(
  result: Exclude<BeginPromotionResult, { status: "ready" | "already_created" }>,
): never {
  switch (result.status) {
    case "unauthorized":
      throw new ApiError("UNAUTHORIZED");
    case "gate_closed":
      throw new ApiError("GATE_CLOSED");
    case "policy_required":
      throw new ApiError("POLICY_ACCEPTANCE_REQUIRED", { required: result.required });
    case "not_found":
      throw new ApiError("NOT_FOUND");
    case "expired":
      throw new ApiError("VALIDATION_FAILED", { reason: "upload_expired" });
    case "processing":
      throw new ApiError("VALIDATION_FAILED", { reason: "upload_processing" });
    case "validation_failed":
      throw new ApiError("VALIDATION_FAILED");
    case "quota_exceeded":
      throw new ApiError("QUOTA_EXCEEDED", { reason: result.reason });
    case "minimum_age_attestation_required":
      throw new ApiError("MINIMUM_AGE_ATTESTATION_REQUIRED");
    case "location_consent_required":
      throw new ApiError("LOCATION_CONSENT_REQUIRED");
    case "location_use_paused":
      throw new ApiError("LOCATION_USE_PAUSED");
    case "location_withdrawal_pending":
      throw new ApiError("LOCATION_WITHDRAWAL_PENDING");
    case "location_correction_pending":
      throw new ApiError("LOCATION_CORRECTION_PENDING");
  }
}

function completeError(
  result: Exclude<CompletePromotionResult, { status: "created" | "already_created" }>,
): ApiError {
  switch (result.status) {
    case "unauthorized":
      return new ApiError("UNAUTHORIZED");
    case "not_found":
      return new ApiError("NOT_FOUND");
    case "expired":
      return new ApiError("VALIDATION_FAILED", { reason: "upload_expired" });
    case "stale":
      return new ApiError("VALIDATION_FAILED", { reason: "upload_processing" });
    case "quota_exceeded":
      return new ApiError("QUOTA_EXCEEDED", { reason: result.reason });
    case "minimum_age_attestation_required":
      return new ApiError("MINIMUM_AGE_ATTESTATION_REQUIRED");
    case "location_consent_required":
      return new ApiError("LOCATION_CONSENT_REQUIRED");
    case "location_use_paused":
      return new ApiError("LOCATION_USE_PAUSED");
    case "location_withdrawal_pending":
      return new ApiError("LOCATION_WITHDRAWAL_PENDING");
    case "location_correction_pending":
      return new ApiError("LOCATION_CORRECTION_PENDING");
  }
}

function isReadyPromotionPathSafe(
  begin: Extract<BeginPromotionResult, { status: "ready" }>,
  requestedTempPath: string,
  processingToken: string,
): boolean {
  const ownedPrefix = `${begin.user_id}/`;
  return begin.temp_path === requestedTempPath
    && begin.temp_path.startsWith(ownedPrefix)
    && begin.permanent_path === `${begin.user_id}/${processingToken}.webp`
    && !begin.temp_path.includes("..")
    && !begin.permanent_path.includes("..")
    && begin.permanent_path.endsWith(".webp");
}

async function deleteConfirmedUnreferencedPermanent(
  dependencies: PersonalCardServiceDependencies,
  input: { uploadId: string; processingToken: string; permanentPath: string },
): Promise<void> {
  let reference: PermanentReferenceResult;
  try {
    reference = await dependencies.confirmPermanentUnreferenced(input);
  } catch {
    return;
  }

  if (reference.status === "unreferenced") {
    await bestEffort(() => dependencies.deletePermanentObject(input.permanentPath));
  }
}

async function releaseProcessing(
  dependencies: PersonalCardServiceDependencies,
  uploadId: string,
  processingToken: string,
): Promise<void> {
  await bestEffort(() => dependencies.releasePromotion({ uploadId, processingToken }));
}

async function deleteAndMarkTemporary(
  dependencies: PersonalCardServiceDependencies,
  uploadId: string,
  tempPath: string,
): Promise<void> {
  const deleted = await bestEffort(() => dependencies.deleteTemporaryObject(tempPath));
  if (deleted) {
    await bestEffort(() => dependencies.markTemporaryDeleted({ uploadId }));
  }
}

export async function issuePersonalCardUpload(
  input: {
    authUserId: string;
    publicGateOpen: boolean;
    upload: PersonalCardUploadInput;
  },
  dependencies: PersonalCardServiceDependencies = defaultDependencies,
): Promise<{ upload_url: string; temp_path: string }> {
  const result = await dependencies.issueUpload({
    authUserId: input.authUserId,
    publicGateOpen: input.publicGateOpen,
    declaredContentType: input.upload.content_type,
    declaredSizeBytes: input.upload.size,
    clientRequestId: input.upload.client_request_id,
  });

  if (result.status !== "issued") {
    throwIssueError(result);
  }

  try {
    return {
      upload_url: await dependencies.createSignedUploadUrl(result.temp_path),
      temp_path: result.temp_path,
    };
  } catch (error) {
    if (!result.replayed) {
      await bestEffortWithin(
        (signal) => dependencies.cancelUploadIssue({
          uploadId: result.upload_id,
          quotaIssuedAt: result.quota_issued_at,
          signal,
        }),
        2_000,
      );
    }
    throw error;
  }
}

export async function deletePersonalCard(input: {
  authUserId: string;
  personalCardId: string;
  clientRequestId: string;
}, requestDeletion: typeof requestPersonalCardDeletion = requestPersonalCardDeletion): Promise<{
  status: "accepted";
}> {
  const result = await requestDeletion(input);
  switch (result.status) {
    case "accepted":
      return { status: "accepted" };
    case "unauthorized":
      throw new ApiError("UNAUTHORIZED");
    case "not_found":
      throw new ApiError("NOT_FOUND");
    case "idempotency_conflict":
      throw new ApiError("IDEMPOTENCY_CONFLICT");
    case "invalid":
      throw new ApiError("VALIDATION_FAILED");
  }
}

export async function promotePersonalCard(
  input: {
    authUserId: string;
    publicGateOpen: boolean;
    promotion: PersonalCardPromotionInput;
  },
  dependencies: PersonalCardServiceDependencies = defaultDependencies,
): Promise<{ personal_card: { id: string; share_slug: null } }> {
  const processingToken = dependencies.createProcessingToken();
  const begin = await dependencies.beginPromotion({
    authUserId: input.authUserId,
    publicGateOpen: input.publicGateOpen,
    acquisitionId: input.promotion.acquisition_id,
    tempPath: input.promotion.temp_path,
    caption: input.promotion.caption,
    processingToken,
  });

  if (begin.status === "already_created") {
    return {
      personal_card: { id: begin.personal_card_id, share_slug: null },
    };
  }
  if (begin.status !== "ready") {
    throwBeginError(begin);
  }
  if (!isReadyPromotionPathSafe(begin, input.promotion.temp_path, processingToken)) {
    await releaseProcessing(dependencies, begin.upload_id, processingToken);
    throw new ApiError("INTERNAL");
  }

  let sourceBytes: Uint8Array;
  try {
    sourceBytes = await dependencies.downloadTemporaryObject(begin.temp_path);
  } catch (error) {
    if (error instanceof PersonalCardStorageError) {
      if (error.kind === "not_found" || error.kind === "invalid") {
        await deleteAndMarkTemporary(dependencies, begin.upload_id, begin.temp_path);
        await releaseProcessing(dependencies, begin.upload_id, processingToken);
        throw new ApiError(error.kind === "not_found" ? "NOT_FOUND" : "VALIDATION_FAILED");
      }
    }
    await releaseProcessing(dependencies, begin.upload_id, processingToken);
    throw error;
  }

  let derivedBytes: Uint8Array;
  try {
    derivedBytes = await dependencies.deriveImage({
      bytes: sourceBytes,
      declaredContentType: begin.declared_content_type,
      declaredSizeBytes: begin.declared_size_bytes,
    });
  } catch (error) {
    await deleteAndMarkTemporary(dependencies, begin.upload_id, begin.temp_path);
    await releaseProcessing(dependencies, begin.upload_id, processingToken);
    if (error instanceof PersonalCardImageValidationError) {
      throw new ApiError("VALIDATION_FAILED");
    }
    throw error;
  }

  try {
    await dependencies.uploadPermanentObject(begin.permanent_path, derivedBytes);
  } catch (error) {
    await releaseProcessing(dependencies, begin.upload_id, processingToken);
    throw error;
  }

  let completed: CompletePromotionResult;
  try {
    completed = await dependencies.completePromotion({
      authUserId: input.authUserId,
      uploadId: begin.upload_id,
      processingToken,
      acquisitionId: input.promotion.acquisition_id,
      permanentPath: begin.permanent_path,
      caption: input.promotion.caption,
      photoSizeBytes: derivedBytes.byteLength,
      expectedUserId: begin.user_id,
    });
  } catch (error) {
    // The RPC may have committed even when its transport or response parsing
    // failed. Preserve the object in that ambiguous state. Begin registered
    // the permanent path in exactly one durable reconciliation ledger before
    // Storage I/O; release intentionally leaves that ledger for the two-pass
    // maintenance worker or a later privacy-right erasure job.
    await releaseProcessing(dependencies, begin.upload_id, processingToken);
    throw error;
  }

  if (completed.status !== "created" && completed.status !== "already_created") {
    await deleteConfirmedUnreferencedPermanent(dependencies, {
      uploadId: begin.upload_id,
      processingToken,
      permanentPath: begin.permanent_path,
    });
    await releaseProcessing(dependencies, begin.upload_id, processingToken);
    throw completeError(completed);
  }

  await deleteAndMarkTemporary(dependencies, begin.upload_id, begin.temp_path);

  return {
    personal_card: { id: completed.personal_card_id, share_slug: null },
  };
}

export async function cleanupExpiredPersonalCardUploads(
  input: {
    limit?: number;
    softRuntimeMs?: number;
    hardRuntimeMs?: number;
  } = {},
  dependencies: PersonalCardServiceDependencies = defaultDependencies,
): Promise<{
  promotion_expired: { processed: number; failed: number };
  signed_url_expired: { processed: number; failed: number };
  permanent: { processed: number; failed: number };
  backlog: StorageCleanupBacklog;
}> {
  const softRuntimeMs = Math.min(Math.max(input.softRuntimeMs ?? 45_000, 50), 45_000);
  const hardRuntimeMs = Math.min(
    Math.max(input.hardRuntimeMs ?? 48_000, softRuntimeMs + 50),
    50_000,
  );
  const startedAt = dependencies.now();
  const softDeadline = startedAt + softRuntimeMs;
  const hardDeadline = startedAt + hardRuntimeMs;
  const hardController = new AbortController();
  const hardTimer = setTimeout(() => hardController.abort(), hardRuntimeMs);
  const workerToken = dependencies.createProcessingToken();
  let promotionExpiredProcessed = 0;
  let promotionExpiredFailed = 0;
  let signedUrlExpiredProcessed = 0;
  let signedUrlExpiredFailed = 0;
  let permanentProcessed = 0;
  let permanentFailed = 0;
  let backlog: StorageCleanupBacklog = {
    status: "ready",
    total_pending: 0,
    promotion_expired_pending: 0,
    signed_url_expired_pending: 0,
    permanent_pending: 0,
    overdue_15m: 0,
    oldest_due_at: null,
  };

  try {
    // One full quantum reserves claim + delete + durable result + final backlog
    // projection. Never claim work that this invocation cannot attempt and
    // release before the platform hard timeout.
    while (
      dependencies.now() < softDeadline
      && hardDeadline - dependencies.now() >= 18_000
    ) {
      const item = await runWithin(
        (signal) => dependencies.claimStorageCleanup({ workerToken, signal }),
        hardController.signal,
        4_000,
      );
      if (item === null) break;

      let deleted = false;
      try {
        await runWithin(
          (signal) => item.kind === "temporary"
            ? dependencies.deleteTemporaryObject(item.path, signal)
            : dependencies.deletePermanentObject(item.path, signal),
          hardController.signal,
          5_000,
        );
        deleted = true;
      } catch {
        deleted = false;
      }

      let recorded = false;
      try {
        await runWithin(
          (signal) => dependencies.recordStorageCleanupResult({
            workerToken,
            item,
            deleted,
            signal,
          }),
          hardController.signal,
          4_000,
        );
        recorded = true;
      } catch {
        recorded = false;
      }

      const succeeded = deleted && recorded;
      if (item.kind === "permanent") {
        if (succeeded) permanentProcessed += 1;
        else permanentFailed += 1;
      } else if (item.phase === "promotion_expired") {
        if (succeeded) promotionExpiredProcessed += 1;
        else promotionExpiredFailed += 1;
      } else if (succeeded) {
        signedUrlExpiredProcessed += 1;
      } else {
        signedUrlExpiredFailed += 1;
      }
    }

    await runWithin(
      (signal) => dependencies.purgeCompletedUploads({ limit: 250, signal }),
      hardController.signal,
      4_000,
    );
    backlog = await runWithin(
      (signal) => dependencies.getStorageCleanupBacklog({ signal }),
      hardController.signal,
      4_000,
    );
  } finally {
    clearTimeout(hardTimer);
    hardController.abort();
  }

  return {
    promotion_expired: {
      processed: promotionExpiredProcessed,
      failed: promotionExpiredFailed,
    },
    signed_url_expired: {
      processed: signedUrlExpiredProcessed,
      failed: signedUrlExpiredFailed,
    },
    permanent: {
      processed: permanentProcessed,
      failed: permanentFailed,
    },
    backlog,
  };
}
