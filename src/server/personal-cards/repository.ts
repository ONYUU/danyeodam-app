import "server-only";

import { z } from "zod";

import type { PersonalCardContentType } from "@/server/personal-cards/input";
import { throwIfAuthenticatedRateLimited } from "@/server/rate-limit/authenticated";
import {
  createSignalScopedServiceClient,
  getServiceClient,
} from "@/server/supabase/service";

const policyRequirementSchema = z.object({
  type: z.enum(["terms_of_use", "community_guidelines"]),
  version: z.string().min(1).max(64),
}).strict();

const issueUploadResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("issued"),
    upload_id: z.uuid(),
    temp_path: z.string().min(1).max(256),
    quota_issued_at: z.iso.datetime({ offset: true }),
    replayed: z.boolean(),
  }),
  z.object({ status: z.literal("unauthorized") }),
  z.object({ status: z.literal("gate_closed") }),
  z.object({
    status: z.literal("policy_required"),
    required: z.array(policyRequirementSchema).max(2),
  }),
  z.object({ status: z.literal("validation_failed") }),
  z.object({ status: z.literal("idempotency_conflict") }),
  z.object({
    status: z.literal("rate_limited"),
    retry_after_seconds: z.number().int().min(1).max(86_400),
  }),
  z.object({
    status: z.literal("quota_exceeded"),
    reason: z.enum([
      "active_temp_uploads",
      "card_count",
      "storage_bytes",
      "permanent_object_backlog",
    ]),
  }),
  z.object({ status: z.literal("minimum_age_attestation_required") }),
  z.object({ status: z.literal("location_consent_required") }),
  z.object({ status: z.literal("location_use_paused") }),
  z.object({ status: z.literal("location_withdrawal_pending") }),
]);

const beginPromotionResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    upload_id: z.uuid(),
    user_id: z.uuid(),
    temp_path: z.string().min(1).max(256),
    permanent_path: z.string().min(1).max(256),
    declared_content_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
    declared_size_bytes: z.number().int().min(1).max(10 * 1024 * 1024),
  }),
  z.object({
    status: z.literal("already_created"),
    personal_card_id: z.uuid(),
  }),
  z.object({ status: z.literal("unauthorized") }),
  z.object({ status: z.literal("gate_closed") }),
  z.object({
    status: z.literal("policy_required"),
    required: z.array(policyRequirementSchema).max(2),
  }),
  z.object({ status: z.literal("not_found") }),
  z.object({ status: z.literal("expired") }),
  z.object({ status: z.literal("processing") }),
  z.object({ status: z.literal("validation_failed") }),
  z.object({
    status: z.literal("quota_exceeded"),
    reason: z.enum(["storage_bytes", "permanent_object_backlog"]),
  }),
  z.object({ status: z.literal("minimum_age_attestation_required") }),
  z.object({ status: z.literal("location_consent_required") }),
  z.object({ status: z.literal("location_use_paused") }),
  z.object({ status: z.literal("location_withdrawal_pending") }),
  z.object({ status: z.literal("location_correction_pending") }),
]);

const completePromotionResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("created"), personal_card_id: z.uuid() }),
  z.object({ status: z.literal("already_created"), personal_card_id: z.uuid() }),
  z.object({ status: z.literal("unauthorized") }),
  z.object({ status: z.literal("not_found") }),
  z.object({ status: z.literal("expired") }),
  z.object({ status: z.literal("stale") }),
  z.object({
    status: z.literal("quota_exceeded"),
    reason: z.enum(["derived_file_size", "card_count", "storage_bytes"]),
  }),
  z.object({ status: z.literal("minimum_age_attestation_required") }),
  z.object({ status: z.literal("location_consent_required") }),
  z.object({ status: z.literal("location_use_paused") }),
  z.object({ status: z.literal("location_withdrawal_pending") }),
  z.object({ status: z.literal("location_correction_pending") }),
]);

const permanentReferenceResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unreferenced") }),
  z.object({ status: z.literal("referenced") }),
  z.object({ status: z.literal("unknown") }),
]);

const maintenanceMutationResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("updated") }),
  z.object({ status: z.literal("not_found") }),
  z.object({ status: z.literal("stale") }),
]);

const cancelUploadIssueResultSchema = z.object({
  status: z.enum(["cancelled", "not_found", "stale", "invalid"]),
}).strict();

const cleanupCandidateSchema = z.object({
  upload_id: z.uuid(),
  temp_path: z.string().min(1).max(256),
});

const storageCleanupItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("temporary"),
    upload_id: z.uuid(),
    path: z.string().min(1).max(256),
    phase: z.enum(["promotion_expired", "signed_url_expired"]),
  }).strict(),
  z.object({
    kind: z.literal("permanent"),
    ledger_id: z.string().regex(/^[1-9][0-9]*$/u),
    path: z.string().min(1).max(256),
    phase: z.enum(["first", "final"]),
  }).strict(),
]);

const storageCleanupClaimSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), item: storageCleanupItemSchema }).strict(),
  z.object({ status: z.literal("empty") }).strict(),
  z.object({ status: z.literal("invalid") }).strict(),
]);

const storageCleanupRecordSchema = z.object({
  status: z.enum([
    "completed",
    "recorded",
    "referenced",
    "retry",
    "not_found",
    "forbidden",
    "invalid",
  ]),
}).strict();

const storageCleanupBacklogSchema = z.object({
  status: z.literal("ready"),
  total_pending: z.number().int().min(0),
  promotion_expired_pending: z.number().int().min(0),
  signed_url_expired_pending: z.number().int().min(0),
  permanent_pending: z.number().int().min(0),
  overdue_15m: z.number().int().min(0),
  oldest_due_at: z.iso.datetime({ offset: true }).nullable(),
}).strict();

const uploadRetentionPurgeSchema = z.object({
  status: z.literal("purged"),
  deleted: z.number().int().nonnegative(),
}).strict();

const personalCardDeletionResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted") }).strict(),
  z.object({ status: z.literal("unauthorized") }).strict(),
  z.object({ status: z.literal("not_found") }).strict(),
  z.object({ status: z.literal("idempotency_conflict") }).strict(),
  z.object({ status: z.literal("invalid") }).strict(),
]);

export type IssueUploadResult = z.infer<typeof issueUploadResultSchema>;
export type BeginPromotionResult = z.infer<typeof beginPromotionResultSchema>;
export type CompletePromotionResult = z.infer<typeof completePromotionResultSchema>;
export type PermanentReferenceResult = z.infer<typeof permanentReferenceResultSchema>;
export type CleanupCandidate = z.infer<typeof cleanupCandidateSchema>;
export type StorageCleanupItem = z.infer<typeof storageCleanupItemSchema>;
export type StorageCleanupBacklog = z.infer<typeof storageCleanupBacklogSchema>;
export type PersonalCardDeletionResult = z.infer<typeof personalCardDeletionResultSchema>;

export class PersonalCardRepositoryError extends Error {
  constructor() {
    super("Personal card repository operation failed");
    this.name = "PersonalCardRepositoryError";
  }
}

async function callRpc(
  functionName: string,
  parameters: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const client = signal === undefined
    ? getServiceClient()
    : createSignalScopedServiceClient(signal);
  let query = client.schema("api_private").rpc(functionName, parameters);
  if (signal !== undefined) query = query.abortSignal(signal);
  const { data, error } = await query;

  if (error !== null) {
    throw new PersonalCardRepositoryError();
  }
  return data;
}

export async function cancelPersonalCardTemporaryUploadIssue(input: {
  uploadId: string;
  quotaIssuedAt: string;
  signal: AbortSignal;
}): Promise<void> {
  cancelUploadIssueResultSchema.parse(
    await callRpc("cancel_personal_card_temp_upload_issue", {
      p_upload_id: input.uploadId,
      p_quota_issued_at: input.quotaIssuedAt,
    }, input.signal),
  );
}

export async function issuePersonalCardTemporaryUpload(input: {
  authUserId: string;
  publicGateOpen: boolean;
  declaredContentType: PersonalCardContentType;
  declaredSizeBytes: number;
  clientRequestId: string;
}): Promise<IssueUploadResult> {
  return issueUploadResultSchema.parse(
    await callRpc("issue_personal_card_temp_upload", {
      p_auth_user_id: input.authUserId,
      p_public_gate_open: input.publicGateOpen,
      p_declared_content_type: input.declaredContentType,
      p_declared_size_bytes: input.declaredSizeBytes,
      p_client_request_id: input.clientRequestId,
    }),
  );
}

export async function requestPersonalCardDeletion(input: {
  authUserId: string;
  personalCardId: string;
  clientRequestId: string;
}): Promise<PersonalCardDeletionResult> {
  return personalCardDeletionResultSchema.parse(
    await callRpc("request_personal_card_deletion", {
      p_auth_user_id: input.authUserId,
      p_personal_card_id: input.personalCardId,
      p_client_request_id: input.clientRequestId,
    }),
  );
}

export async function purgeCompletedPersonalCardUploads(input: {
  limit: number;
  signal?: AbortSignal;
}): Promise<number> {
  const result = uploadRetentionPurgeSchema.parse(
    await callRpc("purge_completed_personal_card_uploads", {
      p_limit: input.limit,
    }, input.signal),
  );
  return result.deleted;
}

export async function beginPersonalCardPromotion(input: {
  authUserId: string;
  publicGateOpen: boolean;
  acquisitionId: string;
  tempPath: string;
  caption: string;
  processingToken: string;
}): Promise<BeginPromotionResult> {
  const result = await callRpc("begin_personal_card_promotion", {
    p_auth_user_id: input.authUserId,
    p_public_gate_open: input.publicGateOpen,
    p_acquisition_id: input.acquisitionId,
    p_temp_path: input.tempPath,
    p_caption: input.caption,
    p_processing_token: input.processingToken,
  });
  throwIfAuthenticatedRateLimited(result);
  return beginPromotionResultSchema.parse(result);
}

export async function completePersonalCardPromotion(input: {
  authUserId: string;
  uploadId: string;
  processingToken: string;
  acquisitionId: string;
  permanentPath: string;
  caption: string;
  photoSizeBytes: number;
  expectedUserId: string;
}): Promise<CompletePromotionResult> {
  return completePromotionResultSchema.parse(
    await callRpc("complete_personal_card_promotion_with_size", {
      p_auth_user_id: input.authUserId,
      p_upload_id: input.uploadId,
      p_processing_token: input.processingToken,
      p_acquisition_id: input.acquisitionId,
      p_permanent_path: input.permanentPath,
      p_caption: input.caption,
      p_photo_size_bytes: input.photoSizeBytes,
      p_expected_user_id: input.expectedUserId,
    }),
  );
}

export async function releasePersonalCardPromotion(input: {
  uploadId: string;
  processingToken: string;
}): Promise<void> {
  maintenanceMutationResultSchema.parse(
    await callRpc("release_personal_card_promotion", {
      p_upload_id: input.uploadId,
      p_processing_token: input.processingToken,
    }),
  );
}

export async function confirmPersonalCardPermanentUnreferenced(input: {
  uploadId: string;
  processingToken: string;
  permanentPath: string;
}): Promise<PermanentReferenceResult> {
  return permanentReferenceResultSchema.parse(
    await callRpc("confirm_personal_card_permanent_unreferenced", {
      p_upload_id: input.uploadId,
      p_processing_token: input.processingToken,
      p_permanent_path: input.permanentPath,
    }),
  );
}

export async function markPersonalCardTemporaryObjectDeleted(input: {
  uploadId: string;
  signal?: AbortSignal;
}): Promise<void> {
  maintenanceMutationResultSchema.parse(
    await callRpc("mark_personal_card_temp_deleted", {
      p_upload_id: input.uploadId,
    }, input.signal),
  );
}

export async function listPersonalCardCleanupCandidates(input: {
  limit: number;
  signal?: AbortSignal;
}): Promise<CleanupCandidate[]> {
  return z.array(cleanupCandidateSchema).parse(
    await callRpc("list_personal_card_temp_cleanup", {
      p_limit: input.limit,
    }, input.signal),
  );
}

export async function listPersonalCardExpiryCleanupCandidates(input: {
  limit: number;
  signal?: AbortSignal;
}): Promise<CleanupCandidate[]> {
  return z.array(cleanupCandidateSchema).parse(
    await callRpc("list_personal_card_expiry_cleanup", {
      p_limit: input.limit,
    }, input.signal),
  );
}

export async function completePersonalCardTemporaryCleanup(input: {
  uploadId: string;
  signal?: AbortSignal;
}): Promise<void> {
  maintenanceMutationResultSchema.parse(
    await callRpc("complete_personal_card_temp_cleanup", {
      p_upload_id: input.uploadId,
    }, input.signal),
  );
}

export async function claimPersonalCardStorageCleanup(input: {
  workerToken: string;
  signal?: AbortSignal;
}): Promise<StorageCleanupItem | null> {
  const result = storageCleanupClaimSchema.parse(
    await callRpc("claim_personal_card_storage_cleanup", {
      p_worker_token: input.workerToken,
      p_limit: 1,
    }, input.signal),
  );
  if (result.status === "invalid") throw new PersonalCardRepositoryError();
  return result.status === "ready" ? result.item : null;
}

export async function recordPersonalCardStorageCleanupResult(input: {
  workerToken: string;
  item: StorageCleanupItem;
  deleted: boolean;
  signal?: AbortSignal;
}): Promise<void> {
  const result = storageCleanupRecordSchema.parse(
    await callRpc("record_personal_card_storage_cleanup_result", {
      p_worker_token: input.workerToken,
      p_kind: input.item.kind,
      p_upload_id: input.item.kind === "temporary" ? input.item.upload_id : null,
      p_ledger_id: input.item.kind === "permanent" ? input.item.ledger_id : null,
      p_phase: input.item.phase,
      p_deleted: input.deleted,
    }, input.signal),
  );
  if (result.status === "forbidden" || result.status === "invalid") {
    throw new PersonalCardRepositoryError();
  }
}

export async function getPersonalCardStorageCleanupBacklog(input: {
  signal?: AbortSignal;
} = {}): Promise<StorageCleanupBacklog> {
  return storageCleanupBacklogSchema.parse(
    await callRpc("get_personal_card_storage_cleanup_backlog", {}, input.signal),
  );
}
