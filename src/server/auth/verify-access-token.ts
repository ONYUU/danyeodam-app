import "server-only";

import { createClient } from "@supabase/supabase-js";

import { requireActiveIdentity } from "@/server/auth/active-identity";
import { getServerEnvironment } from "@/server/env";
import { ApiError } from "@/server/http/api-error";
import { classifyAuthVerificationError } from "@/server/auth/verification-error";

export type VerifiedAuthUser = {
  id: string;
  isAnonymous: boolean;
};

// Account deletion must accept a transport retry after the first request has
// atomically revoked the active product binding. This verifier authenticates
// the Supabase JWT but deliberately does not authorize a product operation.
// Only the deletion RPC may use it; that RPC accepts either an active binding
// or the exact request/auth manifest created by the first deletion request.
export async function verifySupabaseAccessTokenUser(
  token: string,
): Promise<VerifiedAuthUser> {
  const environment = getServerEnvironment();
  const authClient = createClient(
    environment.NEXT_PUBLIC_SUPABASE_URL,
    environment.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    },
  );

  const { data, error } = await authClient.auth.getUser(token);
  if (error !== null) {
    throw new ApiError(classifyAuthVerificationError(error));
  }
  if (data.user === null) {
    throw new ApiError("UNAUTHORIZED");
  }
  return {
    id: data.user.id,
    isAnonymous: data.user.is_anonymous === true,
  };
}

export async function verifyAccessTokenUser(token: string): Promise<VerifiedAuthUser> {
  const user = await verifySupabaseAccessTokenUser(token);
  await requireActiveIdentity(user.id);
  return user;
}

export async function verifyAccessToken(token: string): Promise<string> {
  return (await verifyAccessTokenUser(token)).id;
}
