import "server-only";

import { z } from "zod";

import { getServiceClient } from "@/server/supabase/service";

const commonErrorResults = [
  z.object({ status: z.literal("unauthorized") }).strict(),
  z.object({ status: z.literal("invalid") }).strict(),
  z.object({ status: z.literal("not_found") }).strict(),
  z.object({ status: z.literal("idempotency_conflict") }).strict(),
] as const;

const createBlockResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("blocked"), duplicate: z.boolean() }).strict(),
  z.object({
    status: z.literal("rate_limited"),
    retry_after_seconds: z.number().int().min(1).max(3600),
  }).strict(),
  ...commonErrorResults,
]);

const listBlocksResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    items: z.array(z.object({
      id: z.uuid(),
      created_at: z.iso.datetime({ offset: true }),
    }).strict()).max(100),
    has_more: z.boolean(),
    next_anchor: z.object({
      id: z.uuid(),
      created_at: z.iso.datetime({ offset: true }),
    }).strict().nullable(),
  }).strict(),
  z.object({ status: z.literal("unauthorized") }).strict(),
  z.object({ status: z.literal("invalid") }).strict(),
]);

const revokeBlockResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("revoked"), duplicate: z.boolean() }).strict(),
  ...commonErrorResults,
]);

export type CreateBlockResult = z.infer<typeof createBlockResultSchema>;
export type ListBlocksResult = z.infer<typeof listBlocksResultSchema>;
export type RevokeBlockResult = z.infer<typeof revokeBlockResultSchema>;

export class UserBlockRepositoryError extends Error {
  constructor() {
    super("User block repository operation failed");
    this.name = "UserBlockRepositoryError";
  }
}

async function callRpc(functionName: string, parameters: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await getServiceClient()
    .schema("api_private")
    .rpc(functionName, parameters);
  if (error !== null) throw new UserBlockRepositoryError();
  return data;
}

export async function createUserBlock(input: {
  authUserId: string;
  shareSlug: string;
  clientActionId: string;
  publicSharePublicationOpen: boolean;
}): Promise<CreateBlockResult> {
  return createBlockResultSchema.parse(await callRpc("create_user_block", {
    p_auth_user_id: input.authUserId,
    p_share_slug: input.shareSlug,
    p_client_action_id: input.clientActionId,
    p_public_share_publication_open: input.publicSharePublicationOpen,
  }));
}

export async function listUserBlocks(input: {
  authUserId: string;
  limit: number;
  beforeCreatedAt: string | null;
  beforeId: string | null;
}): Promise<ListBlocksResult> {
  return listBlocksResultSchema.parse(await callRpc("list_user_blocks", {
    p_auth_user_id: input.authUserId,
    p_limit: input.limit,
    p_before_created_at: input.beforeCreatedAt,
    p_before_id: input.beforeId,
  }));
}

export async function revokeUserBlock(input: {
  authUserId: string;
  blockId: string;
  clientActionId: string;
}): Promise<RevokeBlockResult> {
  return revokeBlockResultSchema.parse(await callRpc("revoke_user_block", {
    p_auth_user_id: input.authUserId,
    p_block_id: input.blockId,
    p_client_action_id: input.clientActionId,
  }));
}
