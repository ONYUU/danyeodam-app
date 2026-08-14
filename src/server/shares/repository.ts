import "server-only";

import { z } from "zod";

import { localizedTextSchema } from "@/server/localization/schema";
import { throwIfAuthenticatedRateLimited } from "@/server/rate-limit/authenticated";
import { getServiceClient } from "@/server/supabase/service";

const shareSlugSchema = z.string().regex(/^[A-Za-z0-9]{22,128}$/);
const shareStateSchema = z.enum([
  "private", "pending", "active", "rejected", "taken_down",
]);

const createShareResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pending"),
    share_slug: shareSlugSchema,
    share_state: z.literal("pending"),
  }),
  z.object({
    status: z.literal("existing"),
    share_slug: shareSlugSchema,
    share_state: shareStateSchema,
  }),
  z.object({
    status: z.literal("slug_conflict"),
    expected_user_id: z.uuid(),
  }).strict(),
  z.object({ status: z.literal("unauthorized") }),
  z.object({ status: z.literal("participant_gate_closed") }),
  z.object({ status: z.literal("share_creation_gate_closed") }),
  z.object({ status: z.literal("account_suspended") }),
  z.object({
    status: z.literal("policy_required"),
    required: z.array(z.object({
      type: z.enum(["terms_of_use", "community_guidelines"]),
      version: z.string().min(1).max(64),
    }).strict()).max(2),
  }),
  z.object({ status: z.literal("not_found") }),
  z.object({ status: z.literal("minimum_age_attestation_required") }),
  z.object({ status: z.literal("location_consent_required") }),
  z.object({ status: z.literal("location_use_paused") }),
  z.object({ status: z.literal("location_withdrawal_pending") }),
  z.object({ status: z.literal("location_correction_pending") }),
]);

const shareStatusResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("found"),
    share_state: shareStateSchema,
    share_slug: shareSlugSchema.nullable(),
    reason_code: z.string().max(64).nullable(),
    submitted_at: z.iso.datetime({ offset: true }).nullable(),
    reviewed_at: z.iso.datetime({ offset: true }).nullable(),
  }).strict(),
  z.object({ status: z.literal("unauthorized") }).strict(),
  z.object({ status: z.literal("not_found") }).strict(),
]);

const revokeShareResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("revoked") }),
  z.object({ status: z.literal("already_revoked") }),
  z.object({ status: z.literal("unauthorized") }),
  z.object({ status: z.literal("not_found") }),
]);

const publicShareResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("found"),
    personal_card_id: z.uuid(),
    date_kst: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    spot: z.object({ name: localizedTextSchema }).strict(),
    caption: z.string().max(60),
    photo_path: z.string().min(1).max(256),
  }),
  z.object({ status: z.literal("not_found") }),
  z.object({ status: z.literal("unauthorized") }),
]);

export type CreateShareResult = z.infer<typeof createShareResultSchema>;
export type RevokeShareResult = z.infer<typeof revokeShareResultSchema>;
export type PublicShareResult = z.infer<typeof publicShareResultSchema>;
export type ShareStatusResult = z.infer<typeof shareStatusResultSchema>;

export class ShareRepositoryError extends Error {
  constructor() {
    super("Share repository operation failed");
    this.name = "ShareRepositoryError";
  }
}

async function callRpc(
  functionName: string,
  parameters: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await getServiceClient()
    .schema("api_private")
    .rpc(functionName, parameters);

  if (error !== null) {
    throw new ShareRepositoryError();
  }
  return data;
}

export async function createPersonalCardShare(input: {
  authUserId: string;
  publicGateOpen: boolean;
  publicShareCreationOpen: boolean;
  personalCardId: string;
  shareSlug: string | null;
  expectedUserId?: string;
}): Promise<CreateShareResult> {
  const parameters: Record<string, unknown> = {
    p_auth_user_id: input.authUserId,
    p_public_gate_open: input.publicGateOpen,
    p_public_share_creation_open: input.publicShareCreationOpen,
    p_personal_card_id: input.personalCardId,
    p_share_slug: input.shareSlug,
  };
  if (input.expectedUserId !== undefined) {
    parameters.p_expected_user_id = input.expectedUserId;
  }
  const result = await callRpc(
    input.expectedUserId === undefined
      ? "create_personal_card_share"
      : "create_personal_card_share_continuation",
    parameters,
  );
  throwIfAuthenticatedRateLimited(result);
  return createShareResultSchema.parse(result);
}

export async function revokePersonalCardShare(input: {
  authUserId: string;
  personalCardId: string;
}): Promise<RevokeShareResult> {
  return revokeShareResultSchema.parse(
    await callRpc("revoke_personal_card_share", {
      p_auth_user_id: input.authUserId,
      p_personal_card_id: input.personalCardId,
    }),
  );
}

export async function getPersonalCardShareStatus(input: {
  authUserId: string;
  personalCardId: string;
}): Promise<ShareStatusResult> {
  return shareStatusResultSchema.parse(
    await callRpc("get_personal_card_share_status", {
      p_auth_user_id: input.authUserId,
      p_personal_card_id: input.personalCardId,
    }),
  );
}

export async function getPublicShare(input: {
  shareSlug: string;
  viewerAuthUserId: string | null;
  recordView: boolean;
  publicSharePublicationOpen: boolean;
}): Promise<PublicShareResult> {
  return publicShareResultSchema.parse(
    await callRpc("get_public_share", {
      p_share_slug: input.shareSlug,
      p_viewer_auth_user_id: input.viewerAuthUserId,
      p_record_view: input.recordView,
      p_public_share_publication_open: input.publicSharePublicationOpen,
    }),
  );
}
