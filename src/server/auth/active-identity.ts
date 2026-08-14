import "server-only";

import { z } from "zod";

import { ApiError } from "@/server/http/api-error";
import { getServiceClient } from "@/server/supabase/service";

const activeIdentityResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("active") }),
  z.object({ status: z.literal("inactive") }),
]);

export async function requireActiveIdentity(authUserId: string): Promise<void> {
  const { data, error } = await getServiceClient()
    .schema("api_private")
    .rpc("has_active_identity", {
      p_auth_user_id: authUserId,
    });

  if (error !== null) {
    throw new ApiError("INTERNAL");
  }

  const result = activeIdentityResultSchema.safeParse(data);
  if (!result.success) {
    throw new ApiError("INTERNAL");
  }
  if (result.data.status !== "active") {
    throw new ApiError("UNAUTHORIZED");
  }
}
