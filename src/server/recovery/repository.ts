import "server-only";

import { z } from "zod";

import { getServiceClient } from "@/server/supabase/service";

const issueResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("issued") }),
  z.object({ status: z.literal("unauthorized") }),
  z.object({ status: z.literal("no_acquisition") }),
  z.object({ status: z.literal("reviewer_forbidden") }),
]);

const claimResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("restored") }),
  z.object({ status: z.literal("unauthorized") }),
  z.object({ status: z.literal("not_found") }),
  z.object({ status: z.literal("not_empty") }),
  z.object({ status: z.literal("not_anonymous") }),
  z.object({
    status: z.literal("rate_limited"),
    locked_minutes: z.number().int().positive(),
  }),
]);

export type RecoveryIssueResult = z.infer<typeof issueResultSchema>;
export type RecoveryClaimResult = z.infer<typeof claimResultSchema>;

class RecoveryRepositoryError extends Error {
  constructor() {
    super("Recovery repository operation failed");
    this.name = "RecoveryRepositoryError";
  }
}

export async function issueRecoveryCode(input: {
  authUserId: string;
  codeHashHex: string;
}): Promise<RecoveryIssueResult> {
  const { data, error } = await getServiceClient()
    .schema("api_private")
    .rpc("issue_recovery_code", {
      p_auth_user_id: input.authUserId,
      p_code_hash_hex: input.codeHashHex,
    });

  if (error !== null) {
    throw new RecoveryRepositoryError();
  }
  return issueResultSchema.parse(data);
}

export async function claimRecoveryCode(input: {
  authUserId: string;
  codeHashHex: string;
}): Promise<RecoveryClaimResult> {
  const { data, error } = await getServiceClient()
    .schema("api_private")
    .rpc("claim_recovery_code", {
      p_auth_user_id: input.authUserId,
      p_code_hash_hex: input.codeHashHex,
    });

  if (error?.code === "P0002") {
    return { status: "not_found" };
  }
  if (error !== null) {
    throw new RecoveryRepositoryError();
  }
  return claimResultSchema.parse(data);
}
