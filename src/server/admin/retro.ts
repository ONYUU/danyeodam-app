import "server-only";

import { z } from "zod";

import { ApiError } from "@/server/http/api-error";
import { throwIfAuthenticatedRateLimited } from "@/server/rate-limit/authenticated";
import { getServiceClient } from "@/server/supabase/service";

const inputSchema = z.object({
  app_user_id: z.uuid(),
  spot_id: z.uuid(),
  note: z.string().trim().min(1).max(500),
}).strict();

const acquisitionSchema = z.object({
  id: z.uuid(),
  spot_id: z.uuid(),
  card_id: z.uuid(),
  type: z.literal("retro"),
  acquired_at: z.iso.datetime({ offset: true }),
}).strict();

const resultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("created"), acquisition: acquisitionSchema }),
  z.object({ status: z.literal("existing"), acquisition: acquisitionSchema }),
  z.object({ status: z.literal("unauthorized") }),
  z.object({ status: z.literal("forbidden") }),
  z.object({ status: z.literal("not_found") }),
]);

export type RetroGrantInput = z.infer<typeof inputSchema>;
export type RetroGrantResult = z.infer<typeof resultSchema>;

export function parseRetroGrantInput(value: unknown): RetroGrantInput {
  const result = inputSchema.safeParse(value);
  if (!result.success) {
    throw new ApiError("VALIDATION_FAILED");
  }
  return result.data;
}

export async function grantRetroAcquisition(input: {
  authUserId: string;
  grant: RetroGrantInput;
}): Promise<RetroGrantResult> {
  const { data, error } = await getServiceClient()
    .schema("api_private")
    .rpc("grant_retro_acquisition", {
      p_admin_auth_user_id: input.authUserId,
      p_app_user_id: input.grant.app_user_id,
      p_spot_id: input.grant.spot_id,
      p_note: input.grant.note,
    });

  if (error !== null) {
    throw new Error("Retro grant repository operation failed");
  }
  throwIfAuthenticatedRateLimited(data);
  return resultSchema.parse(data);
}
