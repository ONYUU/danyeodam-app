import "server-only";

import { z } from "zod";

import { localizedTextSchema } from "@/server/localization/schema";
import type {
  ReportModerationActionInput,
  ShareModerationActionInput,
  SuspensionModerationActionInput,
} from "@/server/moderation/input";
import { throwIfAuthenticatedRateLimited } from "@/server/rate-limit/authenticated";
import { getServiceClient } from "@/server/supabase/service";

const errorResults = [
  z.object({ status: z.literal("unauthorized") }).strict(),
  z.object({ status: z.literal("forbidden") }).strict(),
  z.object({ status: z.literal("invalid") }).strict(),
  z.object({ status: z.literal("not_found") }).strict(),
] as const;

const shareStateSchema = z.enum(["pending", "active", "rejected", "taken_down"]);
const allShareStateSchema = z.enum(["private", "pending", "active", "rejected", "taken_down"]);

const shareQueueResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    items: z.array(z.object({
      id: z.uuid(),
      share_state: shareStateSchema,
      submitted_at: z.iso.datetime({ offset: true }),
      caption: z.string().max(60),
      spot_name: localizedTextSchema,
      reason_code: z.string().max(64).nullable(),
      owner_suspended: z.boolean(),
      open_report_count: z.number().int().nonnegative(),
    }).strict()).max(100),
  }).strict(),
  ...errorResults,
]);

const moderationPhotoResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("found"), photo_path: z.string().min(1).max(256) }).strict(),
  ...errorResults,
]);

const shareActionResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["applied", "duplicate"]),
    share_state: allShareStateSchema,
    affected: z.number().int().nonnegative(),
  }).strict(),
  z.object({ status: z.literal("idempotency_conflict") }).strict(),
  z.object({ status: z.literal("publication_gate_closed") }).strict(),
  z.object({ status: z.literal("minimum_age_attestation_required") }).strict(),
  z.object({ status: z.literal("location_consent_required") }).strict(),
  z.object({ status: z.literal("location_use_paused") }).strict(),
  z.object({ status: z.literal("location_withdrawal_pending") }).strict(),
  z.object({ status: z.literal("location_correction_pending") }).strict(),
  z.object({
    status: z.literal("conflict"),
    reason: z.string().min(1).max(64),
  }).strict(),
  ...errorResults,
]);

const reportQueueResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    items: z.array(z.object({
      id: z.uuid(),
      personal_card_id: z.uuid().nullable(),
      target: z.enum(["content", "user"]),
      reason: z.enum([
        "sexual_content", "violence", "hate_or_harassment", "privacy",
        "copyright", "spam", "illegal", "other",
      ]),
      comment: z.string().max(300).nullable(),
      status: z.enum(["open", "resolved", "dismissed"]),
      created_at: z.iso.datetime({ offset: true }),
    }).strict()).max(100),
  }).strict(),
  ...errorResults,
]);

const reportActionResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["applied", "duplicate"]) }).strict(),
  z.object({ status: z.literal("idempotency_conflict") }).strict(),
  z.object({
    status: z.literal("conflict"),
    reason: z.string().min(1).max(64),
  }).strict(),
  ...errorResults,
]);

const suspensionQueueResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    items: z.array(z.object({
      id: z.uuid(),
      suspended_at: z.iso.datetime({ offset: true }),
      lifted_at: z.iso.datetime({ offset: true }).nullable(),
      reason_code: z.string().min(1).max(64),
      note: z.string().min(1).max(500),
    }).strict()).max(100),
  }).strict(),
  ...errorResults,
]);

const suspensionActionResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["applied", "duplicate"]) }).strict(),
  z.object({ status: z.literal("idempotency_conflict") }).strict(),
  z.object({
    status: z.literal("conflict"),
    reason: z.string().min(1).max(64),
  }).strict(),
  ...errorResults,
]);

export type ShareQueueResult = z.infer<typeof shareQueueResultSchema>;
export type ModerationPhotoResult = z.infer<typeof moderationPhotoResultSchema>;
export type ShareActionResult = z.infer<typeof shareActionResultSchema>;
export type ReportQueueResult = z.infer<typeof reportQueueResultSchema>;
export type ReportActionResult = z.infer<typeof reportActionResultSchema>;
export type SuspensionQueueResult = z.infer<typeof suspensionQueueResultSchema>;
export type SuspensionActionResult = z.infer<typeof suspensionActionResultSchema>;

export class ModerationRepositoryError extends Error {
  constructor() {
    super("Moderation repository operation failed");
    this.name = "ModerationRepositoryError";
  }
}

async function callRpc(functionName: string, parameters: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await getServiceClient()
    .schema("api_private")
    .rpc(functionName, parameters);
  if (error !== null) {
    throw new ModerationRepositoryError();
  }
  return data;
}

export async function listShareModerationQueue(input: {
  authUserId: string;
  status: string;
  limit: number;
}): Promise<ShareQueueResult> {
  return shareQueueResultSchema.parse(await callRpc("list_share_moderation_queue", {
    p_admin_auth_user_id: input.authUserId,
    p_share_state: input.status,
    p_limit: input.limit,
  }));
}

export async function getModerationSharePhoto(input: {
  authUserId: string;
  personalCardId: string;
}): Promise<ModerationPhotoResult> {
  return moderationPhotoResultSchema.parse(await callRpc("get_moderation_share_photo", {
    p_admin_auth_user_id: input.authUserId,
    p_personal_card_id: input.personalCardId,
  }));
}

export async function moderatePersonalCardShare(input: {
  authUserId: string;
  personalCardId: string;
  action: ShareModerationActionInput;
  publicSharePublicationOpen: boolean;
}): Promise<ShareActionResult> {
  const result = await callRpc("moderate_personal_card_share", {
    p_admin_auth_user_id: input.authUserId,
    p_personal_card_id: input.personalCardId,
    p_client_action_id: input.action.client_action_id,
    p_action: input.action.action,
    p_reason_code: input.action.reason_code,
    p_note: input.action.note,
    p_public_share_publication_open: input.publicSharePublicationOpen,
  });
  throwIfAuthenticatedRateLimited(result);
  return shareActionResultSchema.parse(result);
}

export async function listContentReports(input: {
  authUserId: string;
  status: string;
  limit: number;
}): Promise<ReportQueueResult> {
  return reportQueueResultSchema.parse(await callRpc("list_content_reports", {
    p_admin_auth_user_id: input.authUserId,
    p_status: input.status,
    p_limit: input.limit,
  }));
}

export async function moderateContentReport(input: {
  authUserId: string;
  reportId: string;
  action: ReportModerationActionInput;
}): Promise<ReportActionResult> {
  const result = await callRpc("moderate_content_report", {
    p_admin_auth_user_id: input.authUserId,
    p_report_id: input.reportId,
    p_client_action_id: input.action.client_action_id,
    p_action: input.action.action,
    p_reason_code: input.action.reason_code,
    p_note: input.action.note,
  });
  throwIfAuthenticatedRateLimited(result);
  return reportActionResultSchema.parse(result);
}

export async function listShareOwnerSuspensions(input: {
  authUserId: string;
  status: string;
  limit: number;
}): Promise<SuspensionQueueResult> {
  return suspensionQueueResultSchema.parse(await callRpc("list_share_owner_suspensions", {
    p_admin_auth_user_id: input.authUserId,
    p_status: input.status,
    p_limit: input.limit,
  }));
}

export async function moderateShareOwnerSuspension(input: {
  authUserId: string;
  suspensionId: string;
  action: SuspensionModerationActionInput;
}): Promise<SuspensionActionResult> {
  const result = await callRpc("moderate_share_owner_suspension", {
    p_admin_auth_user_id: input.authUserId,
    p_suspension_id: input.suspensionId,
    p_client_action_id: input.action.client_action_id,
    p_action: input.action.action,
    p_reason_code: input.action.reason_code,
    p_note: input.action.note,
  });
  throwIfAuthenticatedRateLimited(result);
  return suspensionActionResultSchema.parse(result);
}
