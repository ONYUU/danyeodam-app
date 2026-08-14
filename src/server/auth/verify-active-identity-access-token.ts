import "server-only";

import { z } from "zod";

import { ApiError } from "@/server/http/api-error";
import { getServiceClient } from "@/server/supabase/service";
import { verifyAccessToken } from "@/server/auth/verify-access-token";

const activeIdentitySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("active") }).strict(),
  z.object({ status: z.literal("inactive") }).strict(),
]);

export async function verifyActiveIdentityAccessToken(token: string): Promise<string> {
  const authUserId = await verifyAccessToken(token);
  const { data, error } = await getServiceClient()
    .schema("api_private")
    .rpc("has_active_service_identity", { p_auth_user_id: authUserId });
  if (error !== null) throw new ApiError("INTERNAL");
  const result = activeIdentitySchema.safeParse(data);
  if (!result.success) throw new ApiError("INTERNAL");
  if (result.data.status === "inactive") throw new ApiError("UNAUTHORIZED");
  return authUserId;
}
