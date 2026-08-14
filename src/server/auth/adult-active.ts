import "server-only";

import { z } from "zod";

import { ApiError } from "@/server/http/api-error";
import { getServiceClient } from "@/server/supabase/service";

const resultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("active") }).strict(),
  z.object({ status: z.literal("inactive") }).strict(),
  z.object({ status: z.literal("minimum_age_attestation_required") }).strict(),
]);

export async function requireAdultActiveIdentity(authUserId: string): Promise<void> {
  const { data, error } = await getServiceClient()
    .schema("api_private")
    .rpc("has_active_adult_identity", { p_auth_user_id: authUserId });

  if (error !== null) throw new ApiError("INTERNAL");
  const parsed = resultSchema.safeParse(data);
  if (!parsed.success) throw new ApiError("INTERNAL");
  if (parsed.data.status === "inactive") throw new ApiError("UNAUTHORIZED");
  if (parsed.data.status === "minimum_age_attestation_required") {
    throw new ApiError("MINIMUM_AGE_ATTESTATION_REQUIRED");
  }
}
