import "server-only";

import { z } from "zod";

import { ApiError } from "@/server/http/api-error";
import { getServiceClient } from "@/server/supabase/service";

const preparedSchema = z.object({
  status: z.literal("prepared"),
  action: z.enum(["provision", "reset"]),
  store_platform: z.enum(["app_store", "play_store"]),
  fixture_version: z.string().min(1).max(64),
  photo_object_id: z.uuid(),
  photo_size_bytes: z.number().int().positive().max(5 * 1024 * 1024),
  photo_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  old_photo_object_ids: z.array(z.uuid()).max(1),
}).strict();

const appliedSchema = z.object({
  status: z.literal("applied"),
  store_platform: z.enum(["app_store", "play_store"]),
  fixture_version: z.string().min(1).max(64),
  retro_count: z.literal(6),
  personal_card_count: z.literal(1),
  active_share_count: z.literal(1),
  fixture_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  photo_object_id: z.uuid(),
  photo_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  photo_size_bytes: z.number().int().positive().max(5 * 1024 * 1024),
  previous_photo_object_id: z.uuid().nullable(),
}).strict();

const errorResultSchema = z.union([
  z.object({ status: z.literal("unauthorized") }).strict(),
  z.object({ status: z.literal("forbidden") }).strict(),
  z.object({ status: z.literal("invalid") }).strict(),
  z.object({ status: z.literal("not_found") }).strict(),
  z.object({ status: z.literal("idempotency_conflict") }).strict(),
  z.object({ status: z.literal("fixture_conflict") }).strict(),
  z.object({ status: z.literal("credential_invalid") }).strict(),
  z.object({
    status: z.literal("rate_limited"),
    retry_after_seconds: z.number().int().min(1).max(60),
  }).strict(),
]);

const prepareResultSchema = z.union([preparedSchema, appliedSchema, errorResultSchema]);
const completeResultSchema = z.union([appliedSchema, errorResultSchema]);
const revokeResultSchema = z.union([
  z.object({
    status: z.literal("revoked"),
    participant_rows: z.number().int().nonnegative(),
    identity_rows: z.number().int().nonnegative(),
    recovery_code_rows: z.number().int().nonnegative(),
    share_rows: z.number().int().nonnegative(),
    old_photo_object_ids: z.array(z.uuid()),
  }).strict(),
  errorResultSchema,
]);

export type ReviewerFixturePrepared = z.infer<typeof preparedSchema>;
export type ReviewerFixtureAppliedInternal = z.infer<typeof appliedSchema>;
export type ReviewerRevokedInternal = Extract<
  z.infer<typeof revokeResultSchema>,
  { status: "revoked" }
>;

async function callRpc(name: string, parameters: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await getServiceClient()
    .schema("api_private")
    .rpc(name, parameters);
  if (error !== null) throw new ApiError("INTERNAL");
  return data;
}

function throwForErrorResult(result: z.infer<typeof errorResultSchema>): never {
  switch (result.status) {
    case "unauthorized": throw new ApiError("UNAUTHORIZED");
    case "forbidden": throw new ApiError("FORBIDDEN");
    case "invalid": throw new ApiError("VALIDATION_FAILED");
    case "not_found": throw new ApiError("NOT_FOUND");
    case "idempotency_conflict": throw new ApiError("IDEMPOTENCY_CONFLICT");
    case "fixture_conflict":
      throw new ApiError("MODERATION_CONFLICT", { reason: "reviewer_fixture_conflict" });
    case "credential_invalid":
      throw new ApiError("MODERATION_CONFLICT", { reason: "reviewer_credential_invalid" });
    case "rate_limited":
      throw new ApiError("RATE_LIMITED", {
        retry_after_seconds: result.retry_after_seconds,
      });
  }
}

function unwrap<T extends ReviewerFixturePrepared | ReviewerFixtureAppliedInternal>(
  result: T | z.infer<typeof errorResultSchema>,
): T {
  if (result.status !== "prepared" && result.status !== "applied") {
    return throwForErrorResult(result);
  }
  return result as T;
}

export async function prepareReviewerProvision(input: {
  adminAuthUserId: string;
  appUserId: string;
  storePlatform: "app_store" | "play_store";
  fixtureVersion: string;
  clientActionId: string;
  photoSizeBytes: number;
  photoSha256Hex: string;
}): Promise<ReviewerFixturePrepared | ReviewerFixtureAppliedInternal> {
  return unwrap(prepareResultSchema.parse(await callRpc("provision_reviewer_access", {
    p_admin_auth_user_id: input.adminAuthUserId,
    p_user_id: input.appUserId,
    p_store_platform: input.storePlatform,
    p_fixture_version: input.fixtureVersion,
    p_client_action_id: input.clientActionId,
    p_photo_size_bytes: input.photoSizeBytes,
    p_photo_sha256_hex: input.photoSha256Hex,
  })));
}

export async function prepareReviewerReset(input: {
  adminAuthUserId: string;
  appUserId: string;
  clientActionId: string;
  photoSizeBytes: number;
  photoSha256Hex: string;
}): Promise<ReviewerFixturePrepared | ReviewerFixtureAppliedInternal> {
  return unwrap(prepareResultSchema.parse(await callRpc("reset_reviewer_access", {
    p_admin_auth_user_id: input.adminAuthUserId,
    p_user_id: input.appUserId,
    p_client_action_id: input.clientActionId,
    p_photo_size_bytes: input.photoSizeBytes,
    p_photo_sha256_hex: input.photoSha256Hex,
  })));
}

export async function completeReviewerFixture(input: {
  adminAuthUserId: string;
  appUserId: string;
  clientActionId: string;
  photoObjectId: string;
  photoSizeBytes: number;
  photoSha256Hex: string;
}): Promise<ReviewerFixtureAppliedInternal> {
  const result = completeResultSchema.parse(await callRpc(
    "complete_reviewer_access_fixture",
    {
      p_admin_auth_user_id: input.adminAuthUserId,
      p_user_id: input.appUserId,
      p_client_action_id: input.clientActionId,
      p_photo_object_id: input.photoObjectId,
      p_photo_size_bytes: input.photoSizeBytes,
      p_photo_sha256_hex: input.photoSha256Hex,
    },
  ));
  return unwrap(result);
}

export async function revokeReviewerFixture(input: {
  adminAuthUserId: string;
  appUserId: string;
  clientActionId: string;
}): Promise<ReviewerRevokedInternal> {
  const result = revokeResultSchema.parse(await callRpc("revoke_reviewer_access", {
    p_admin_auth_user_id: input.adminAuthUserId,
    p_user_id: input.appUserId,
    p_client_action_id: input.clientActionId,
  }));
  if (result.status !== "revoked") return throwForErrorResult(result);
  return result;
}
