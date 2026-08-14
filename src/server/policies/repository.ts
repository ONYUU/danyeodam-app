import "server-only";

import { z } from "zod";

import { supportedLocales } from "@/server/localization/schema";
import type { PolicyAcceptanceInput } from "@/server/policies/input";
import { getServiceClient } from "@/server/supabase/service";

const documentMetadataSchema = z.object({
  url: z.url().refine((value) => new URL(value).protocol === "https:"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

const localizedDocumentsSchema = z.object(Object.fromEntries(
  supportedLocales.map((locale) => [locale, documentMetadataSchema]),
) as Record<(typeof supportedLocales)[number], typeof documentMetadataSchema>).strict();

const currentPoliciesResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    policies: z.array(z.object({
      type: z.enum([
        "terms_of_use",
        "privacy_policy",
        "community_guidelines",
        "location_terms",
      ]),
      version: z.string().min(1).max(64),
      effective_at: z.iso.datetime({ offset: true }),
      documents: localizedDocumentsSchema,
    }).strict()).length(4),
  }).strict(),
  z.object({ status: z.literal("not_ready") }).strict(),
]);

const acceptPoliciesResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted") }).strict(),
  z.object({ status: z.literal("unauthorized") }).strict(),
  z.object({ status: z.literal("invalid") }).strict(),
  z.object({
    status: z.literal("policy_required"),
    required: z.array(z.object({
      type: z.enum(["terms_of_use", "community_guidelines"]),
      version: z.string().min(1).max(64),
    }).strict()).max(2),
  }).strict(),
]);

export type CurrentPoliciesResult = z.infer<typeof currentPoliciesResultSchema>;
export type AcceptPoliciesResult = z.infer<typeof acceptPoliciesResultSchema>;

export class PolicyRepositoryError extends Error {
  constructor() {
    super("Policy repository operation failed");
    this.name = "PolicyRepositoryError";
  }
}

async function callRpc(
  functionName: string,
  parameters: Record<string, unknown> = {},
): Promise<unknown> {
  const { data, error } = await getServiceClient()
    .schema("api_private")
    .rpc(functionName, parameters);
  if (error !== null) {
    throw new PolicyRepositoryError();
  }
  return data;
}

export async function getCurrentPolicies(): Promise<CurrentPoliciesResult> {
  return currentPoliciesResultSchema.parse(await callRpc("get_current_policies"));
}

export async function acceptCurrentPolicies(input: {
  authUserId: string;
  acceptance: PolicyAcceptanceInput;
}): Promise<AcceptPoliciesResult> {
  return acceptPoliciesResultSchema.parse(await callRpc("accept_current_policies", {
    p_auth_user_id: input.authUserId,
    p_acceptances: input.acceptance.acceptances,
  }));
}
