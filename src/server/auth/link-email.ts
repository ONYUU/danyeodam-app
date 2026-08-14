import "server-only";

import { getServerEnvironment } from "@/server/env";
import { ApiError } from "@/server/http/api-error";
import type { LinkEmailInput } from "@/server/auth/link-email-input";

const conflictCodes = new Set([
  "email_exists",
  "email_conflict_identity_not_deletable",
  "user_already_exists",
  "conflict",
]);

const authRequestTimeoutMs = 10_000;

function buildEmailRedirect(baseUrl: string, flowId: string): string {
  const redirect = new URL(baseUrl);
  redirect.searchParams.set("sb_flow_id", flowId);
  return redirect.toString();
}

export async function requestEmailLink(
  token: string,
  input: LinkEmailInput,
): Promise<void> {
  const environment = getServerEnvironment();
  const endpoint = new URL("/auth/v1/user", environment.NEXT_PUBLIC_SUPABASE_URL);
  endpoint.searchParams.set(
    "redirect_to",
    buildEmailRedirect(environment.AUTH_EMAIL_REDIRECT_TO, input.flow_id),
  );

  const response = await fetch(endpoint, {
    method: "PUT",
    headers: {
      apikey: environment.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: input.email,
      code_challenge: input.code_challenge,
      code_challenge_method: input.code_challenge_method,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(authRequestTimeoutMs),
  });

  if (response.ok) {
    return;
  }

  const payload = await response.json().catch(() => ({})) as { code?: unknown };
  if (typeof payload.code === "string" && conflictCodes.has(payload.code)) {
    throw new ApiError("EMAIL_ALREADY_IN_USE");
  }
  if (response.status === 401) {
    throw new ApiError("UNAUTHORIZED");
  }
  if (response.status === 429) {
    throw new ApiError("RATE_LIMITED");
  }
  throw new ApiError("INTERNAL");
}
