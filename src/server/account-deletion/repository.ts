import "server-only";

import { z } from "zod";

import { ApiError } from "@/server/http/api-error";
import {
  createSignalScopedServiceClient,
  getServiceClient,
} from "@/server/supabase/service";

const deletionRequestViewSchema = z.object({
  id: z.uuid(),
  status: z.enum(["pending", "completed"]),
  requested_at: z.iso.datetime({ offset: true }),
  complete_by: z.iso.datetime({ offset: true }),
}).strict();

const requestResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("accepted"),
    deletion_request: deletionRequestViewSchema,
  }).strict(),
  z.object({ status: z.literal("unauthorized") }).strict(),
  z.object({ status: z.literal("not_found") }).strict(),
  z.object({ status: z.literal("idempotency_conflict") }).strict(),
  z.object({ status: z.literal("already_requested") }).strict(),
  z.object({
    status: z.literal("rate_limited"),
    retry_after_seconds: z.number().int().positive(),
  }).strict(),
]);

const statusCandidateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_found") }).strict(),
  z.object({
    status: z.literal("found"),
    status_token_hash: z.string().regex(/^[a-f0-9]{64}$/u),
    id: z.uuid(),
    public_status: z.enum(["pending", "completed"]),
    reason_code: z.enum(["processing", "retrying", "overdue"]).nullable(),
    requested_at: z.iso.datetime({ offset: true }),
    complete_by: z.iso.datetime({ offset: true }),
    completed_at: z.iso.datetime({ offset: true }).nullable(),
  }).strict(),
]);

const rateLimitResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("allowed"),
    retry_after_seconds: z.number().int().positive(),
  }).strict(),
  z.object({
    status: z.literal("rate_limited"),
    retry_after_seconds: z.number().int().positive(),
  }).strict(),
]);

export const accountDeletionStorageItemSchema = z.object({
  id: z.number().int().positive(),
  bucket: z.enum(["personal-card-temp", "personal-cards"]),
  object_path: z.string().min(1).max(512),
  pass: z.enum(["first", "final"]),
}).strict();

export const accountDeletionLeasedJobSchema = z.object({
  id: z.uuid(),
  phase: z.enum([
    "storage_initial",
    "storage_final",
    "database",
    "auth",
    "finalize",
  ]),
  storage_prefix: z.uuid().nullable(),
  storage_items: z.array(accountDeletionStorageItemSchema).max(4),
  auth_user_ids: z.array(z.uuid()).max(4),
}).strict();

const claimSchema = z.object({
  status: z.literal("ready"),
  jobs: z.array(accountDeletionLeasedJobSchema).max(1),
}).strict();

const registerSchema = z.object({
  status: z.literal("registered"),
  count: z.number().int().min(1).max(4),
}).strict();

const recordSchema = z.object({
  status: z.enum(["recorded", "retry", "not_found", "forbidden", "invalid"]),
}).strict();

const markAuthSchema = z.object({
  status: z.enum(["removed", "not_found", "forbidden"]),
}).strict();

const advanceSchema = z.object({
  status: z.enum([
    "advanced",
    "retry",
    "completed",
    "not_ready",
    "forbidden",
    "invalid",
  ]),
}).strict();

const failSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("retrying"),
    retry_after_seconds: z.number().int().positive(),
  }).strict(),
  z.object({ status: z.enum(["forbidden", "invalid"]) }).strict(),
]);

export const backlogSchema = z.object({
  status: z.literal("ready"),
  pending_jobs: z.number().int().nonnegative(),
  overdue_jobs: z.number().int().nonnegative(),
  high_attempt_jobs: z.number().int().nonnegative(),
  max_attempt_count: z.number().int().nonnegative(),
  oldest_requested_at: z.iso.datetime({ offset: true }).nullable(),
  retrying_jobs: z.number().int().nonnegative(),
  completed_receipts: z.number().int().nonnegative(),
}).strict();

const adminBacklogSchema = z.discriminatedUnion("status", [
  backlogSchema,
  z.object({ status: z.literal("forbidden") }).strict(),
]);

const accountDeletionAdminJobSchema = z.object({
  id: z.uuid(),
  status: z.enum(["pending", "processing", "completed"]),
  phase: z.enum([
    "storage_initial",
    "storage_final",
    "database",
    "auth",
    "finalize",
    "done",
  ]),
  last_error_code: z.enum([
    "STORAGE_LIST_FAILED",
    "STORAGE_DELETE_FAILED",
    "DATABASE_DELETE_FAILED",
    "AUTH_DELETE_FAILED",
    "WORKER_TIMEOUT",
    "WORKER_UNEXPECTED",
  ]).nullable(),
  last_error_at: z.iso.datetime({ offset: true }).nullable(),
  attempt_count: z.number().int().nonnegative(),
  consecutive_failure_count: z.number().int().nonnegative(),
  requested_at: z.iso.datetime({ offset: true }),
  complete_by: z.iso.datetime({ offset: true }),
  next_attempt_at: z.iso.datetime({ offset: true }).nullable(),
  lease_state: z.enum(["none", "active", "expired"]),
  lease_expires_at: z.iso.datetime({ offset: true }).nullable(),
  database_deleted_at: z.iso.datetime({ offset: true }).nullable(),
  completed_at: z.iso.datetime({ offset: true }).nullable(),
  updated_at: z.iso.datetime({ offset: true }),
}).strict();

const accountDeletionAdminListSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    items: z.array(accountDeletionAdminJobSchema).max(100),
  }).strict(),
  z.object({ status: z.literal("forbidden") }).strict(),
  z.object({ status: z.literal("invalid") }).strict(),
]);

const accountDeletionAdminRetrySchema = z.union([
  z.object({
    status: z.literal("retry_scheduled"),
    id: z.uuid(),
    next_attempt_at: z.iso.datetime({ offset: true }),
  }).strict(),
  z.object({ status: z.literal("completed"), id: z.uuid() }).strict(),
  z.object({
    status: z.literal("duplicate"),
    id: z.uuid(),
    original_status: z.literal("retry_scheduled"),
    next_attempt_at: z.iso.datetime({ offset: true }),
  }).strict(),
  z.object({
    status: z.literal("duplicate"),
    id: z.uuid(),
    original_status: z.literal("completed"),
  }).strict(),
  z.object({ status: z.literal("forbidden") }).strict(),
  z.object({ status: z.literal("invalid") }).strict(),
  z.object({ status: z.literal("not_found") }).strict(),
  z.object({ status: z.literal("idempotency_conflict") }).strict(),
  z.object({
    status: z.literal("rate_limited"),
    retry_after_seconds: z.number().int().min(1).max(60),
  }).strict(),
]);

export type AccountDeletionRequestResult = z.infer<typeof requestResultSchema>;
export type AccountDeletionStatusCandidate = z.infer<typeof statusCandidateSchema>;
export type AccountDeletionLeasedJob = z.infer<typeof accountDeletionLeasedJobSchema>;
export type AccountDeletionBacklog = z.infer<typeof backlogSchema>;
export type AccountDeletionAdminJob = z.infer<typeof accountDeletionAdminJobSchema>;
export type AccountDeletionAdminRetryResult = Extract<
  z.infer<typeof accountDeletionAdminRetrySchema>,
  { status: "retry_scheduled" | "completed" | "duplicate" }
>;
export type AccountDeletionWorkerErrorCode =
  | "STORAGE_LIST_FAILED"
  | "STORAGE_DELETE_FAILED"
  | "DATABASE_DELETE_FAILED"
  | "AUTH_DELETE_FAILED"
  | "WORKER_TIMEOUT"
  | "WORKER_UNEXPECTED";

async function callRpc(
  name: string,
  parameters: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const client = signal === undefined
    ? getServiceClient()
    : createSignalScopedServiceClient(signal);
  let query = client.schema("api_private").rpc(name, parameters);
  if (signal !== undefined) query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error !== null) throw new ApiError("INTERNAL");
  return data;
}

export async function requestAccountDeletion(input: {
  authUserId: string;
  requestId: string;
  statusTokenHashHex: string;
}): Promise<AccountDeletionRequestResult> {
  return requestResultSchema.parse(await callRpc("request_account_deletion", {
    p_auth_user_id: input.authUserId,
    p_request_id: input.requestId,
    p_status_token_hash_hex: input.statusTokenHashHex,
  }));
}

export async function requestAccountDeletionByRecovery(input: {
  recoveryCodeHashHex: string;
  requestId: string;
  statusTokenHashHex: string;
}): Promise<AccountDeletionRequestResult> {
  return requestResultSchema.parse(await callRpc(
    "request_account_deletion_by_recovery",
    {
      p_recovery_code_hash_hex: input.recoveryCodeHashHex,
      p_request_id: input.requestId,
      p_status_token_hash_hex: input.statusTokenHashHex,
    },
  ));
}

export async function getAccountDeletionStatusCandidate(
  requestId: string,
): Promise<AccountDeletionStatusCandidate> {
  return statusCandidateSchema.parse(await callRpc(
    "get_account_deletion_status_candidate",
    { p_request_id: requestId },
  ));
}

export async function consumeAccountDeletionPublicRateLimit(input: {
  scope: "account_deletion_recovery_ip" | "account_deletion_status_ip";
  subjectHashHex: string;
}): Promise<z.infer<typeof rateLimitResultSchema>> {
  return rateLimitResultSchema.parse(await callRpc(
    "consume_account_deletion_public_rate_limit",
    {
      p_scope: input.scope,
      p_subject_hash_hex: input.subjectHashHex,
    },
  ));
}

export async function claimAccountDeletionJobs(input: {
  workerToken: string;
  signal: AbortSignal;
}): Promise<AccountDeletionLeasedJob[]> {
  const result = claimSchema.parse(await callRpc("claim_account_deletion_jobs", {
    p_worker_token: input.workerToken,
    p_job_limit: 1,
    p_item_limit: 4,
  }, input.signal));
  return result.jobs;
}

export async function registerAccountDeletionStoragePaths(input: {
  requestId: string;
  workerToken: string;
  paths: { bucket: "personal-card-temp" | "personal-cards"; object_path: string }[];
  signal: AbortSignal;
}): Promise<void> {
  registerSchema.parse(await callRpc("register_account_deletion_storage_paths", {
    p_request_id: input.requestId,
    p_worker_token: input.workerToken,
    p_paths: input.paths,
  }, input.signal));
}

export async function recordAccountDeletionStorageResult(input: {
  requestId: string;
  workerToken: string;
  itemId: number;
  pass: "first" | "final";
  deleted: boolean;
  signal: AbortSignal;
}): Promise<z.infer<typeof recordSchema>["status"]> {
  return recordSchema.parse(await callRpc(
    "record_account_deletion_storage_result",
    {
      p_request_id: input.requestId,
      p_worker_token: input.workerToken,
      p_item_id: input.itemId,
      p_pass: input.pass,
      p_deleted: input.deleted,
    },
    input.signal,
  )).status;
}

export async function markAccountDeletionAuthRemoved(input: {
  requestId: string;
  workerToken: string;
  authUserId: string;
  signal: AbortSignal;
}): Promise<z.infer<typeof markAuthSchema>["status"]> {
  return markAuthSchema.parse(await callRpc(
    "mark_account_deletion_auth_removed",
    {
      p_request_id: input.requestId,
      p_worker_token: input.workerToken,
      p_auth_user_id: input.authUserId,
    },
    input.signal,
  )).status;
}

export async function advanceAccountDeletionJob(input: {
  requestId: string;
  workerToken: string;
  completedPhase: AccountDeletionLeasedJob["phase"];
  prefixScanEmpty: boolean;
  signal: AbortSignal;
}): Promise<z.infer<typeof advanceSchema>["status"]> {
  return advanceSchema.parse(await callRpc("advance_account_deletion_job", {
    p_request_id: input.requestId,
    p_worker_token: input.workerToken,
    p_completed_phase: input.completedPhase,
    p_prefix_scan_empty: input.prefixScanEmpty,
  }, input.signal)).status;
}

export async function failAccountDeletionJob(input: {
  requestId: string;
  workerToken: string;
  errorCode: AccountDeletionWorkerErrorCode;
  signal: AbortSignal;
}): Promise<z.infer<typeof failSchema>["status"]> {
  return failSchema.parse(await callRpc("fail_account_deletion_job", {
    p_request_id: input.requestId,
    p_worker_token: input.workerToken,
    p_error_code: input.errorCode,
  }, input.signal)).status;
}

export async function getAccountDeletionBacklog(
  signal?: AbortSignal,
): Promise<AccountDeletionBacklog> {
  return backlogSchema.parse(await callRpc(
    "get_account_deletion_backlog",
    {},
    signal,
  ));
}

export async function getAccountDeletionBacklogAdmin(
  adminAuthUserId: string,
): Promise<AccountDeletionBacklog> {
  const result = adminBacklogSchema.parse(await callRpc(
    "get_account_deletion_backlog_admin",
    { p_admin_auth_user_id: adminAuthUserId },
  ));
  if (result.status === "forbidden") throw new ApiError("FORBIDDEN");
  return result;
}

export async function listAccountDeletionJobsAdmin(input: {
  adminAuthUserId: string;
  status: "active" | "pending" | "processing" | "completed" | "all";
  limit: number;
}): Promise<AccountDeletionAdminJob[]> {
  const result = accountDeletionAdminListSchema.parse(await callRpc(
    "list_account_deletion_jobs_admin",
    {
      p_admin_auth_user_id: input.adminAuthUserId,
      p_status: input.status,
      p_limit: input.limit,
    },
  ));
  if (result.status === "forbidden") throw new ApiError("FORBIDDEN");
  if (result.status === "invalid") throw new ApiError("VALIDATION_FAILED");
  return result.items;
}

export async function retryAccountDeletionJobAdmin(input: {
  adminAuthUserId: string;
  requestId: string;
  clientActionId: string;
  reasonCode: "OVERDUE" | "TRANSIENT_FAILURE" | "WORKER_STALLED" | "MANUAL_REVIEW";
  note: string;
}): Promise<AccountDeletionAdminRetryResult> {
  const result = accountDeletionAdminRetrySchema.parse(await callRpc(
    "retry_account_deletion_job_admin",
    {
      p_admin_auth_user_id: input.adminAuthUserId,
      p_request_id: input.requestId,
      p_client_action_id: input.clientActionId,
      p_reason_code: input.reasonCode,
      p_note: input.note,
    },
  ));
  if (result.status === "forbidden") throw new ApiError("FORBIDDEN");
  if (result.status === "invalid") throw new ApiError("VALIDATION_FAILED");
  if (result.status === "not_found") throw new ApiError("NOT_FOUND");
  if (result.status === "idempotency_conflict") {
    throw new ApiError("IDEMPOTENCY_CONFLICT");
  }
  if (result.status === "rate_limited") {
    throw new ApiError("RATE_LIMITED", {
      retry_after_seconds: result.retry_after_seconds,
    });
  }
  return result;
}
