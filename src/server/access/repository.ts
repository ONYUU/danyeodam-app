import "server-only";

import { z } from "zod";

import { getServiceClient } from "@/server/supabase/service";

const accessProjectionResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unauthorized") }),
  z.object({
    status: z.literal("ready"),
    participant: z.boolean(),
    access_type: z.enum(["standard", "store_reviewer"]),
    field_acquisition_requires_location: z.literal(true),
    fixture_version: z.string().min(1).max(64).nullable(),
  }),
]);

const emailLinkEligibilitySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("eligible") }),
  z.object({ status: z.literal("reviewer_forbidden") }),
  z.object({ status: z.literal("unauthorized") }),
]);

export type AccessProjectionResult = z.infer<typeof accessProjectionResultSchema>;
export type EmailLinkEligibility = z.infer<typeof emailLinkEligibilitySchema>;

class AccessRepositoryError extends Error {
  constructor() {
    super("Access projection lookup failed");
    this.name = "AccessRepositoryError";
  }
}

export async function getAccessProjection(
  authUserId: string,
): Promise<AccessProjectionResult> {
  const { data, error } = await getServiceClient()
    .schema("api_private")
    .rpc("get_access_projection", {
      p_auth_user_id: authUserId,
    });

  if (error !== null) {
    throw new AccessRepositoryError();
  }

  const result = accessProjectionResultSchema.safeParse(data);
  if (!result.success) {
    throw new AccessRepositoryError();
  }
  return result.data;
}

export async function getEmailLinkEligibility(
  authUserId: string,
): Promise<EmailLinkEligibility> {
  const { data, error } = await getServiceClient()
    .schema("api_private")
    .rpc("get_email_link_eligibility", {
      p_auth_user_id: authUserId,
    });

  if (error !== null) {
    throw new AccessRepositoryError();
  }

  const result = emailLinkEligibilitySchema.safeParse(data);
  if (!result.success) {
    throw new AccessRepositoryError();
  }
  return result.data;
}
