import "server-only";

import { z } from "zod";

import { throwIfAuthenticatedRateLimited } from "@/server/rate-limit/authenticated";
import { getServiceClient } from "@/server/supabase/service";

const redeemResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("redeemed") }),
  z.object({ status: z.literal("not_found") }),
  z.object({ status: z.literal("unauthorized") }),
  z.object({
    status: z.literal("rate_limited"),
    locked_minutes: z.number().int().positive(),
  }),
]);

const issueResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("created"), count: z.number().int().positive() }),
  z.object({ status: z.literal("unauthorized") }),
  z.object({ status: z.literal("forbidden") }),
]);

export type ParticipantRedeemResult = z.infer<typeof redeemResultSchema>;
export type ParticipantIssueResult = z.infer<typeof issueResultSchema>;

class ParticipantRepositoryError extends Error {
  constructor() {
    super("Participant repository operation failed");
    this.name = "ParticipantRepositoryError";
  }
}

export async function redeemParticipantInvite(input: {
  authUserId: string;
  codeHashHex: string;
}): Promise<ParticipantRedeemResult> {
  const { data, error } = await getServiceClient()
    .schema("api_private")
    .rpc("redeem_participant_invite", {
      p_auth_user_id: input.authUserId,
      p_code_hash_hex: input.codeHashHex,
    });

  if (error !== null) {
    throw new ParticipantRepositoryError();
  }
  return redeemResultSchema.parse(data);
}

export async function issueParticipantInvites(input: {
  authUserId: string;
  codeHashHexes: string[];
  note?: string;
}): Promise<ParticipantIssueResult> {
  const { data, error } = await getServiceClient()
    .schema("api_private")
    .rpc("issue_participant_invites", {
      p_auth_user_id: input.authUserId,
      p_code_hash_hexes: input.codeHashHexes,
      p_note: input.note ?? null,
    });

  if (error !== null) {
    throw new ParticipantRepositoryError();
  }
  throwIfAuthenticatedRateLimited(data);
  return issueResultSchema.parse(data);
}
