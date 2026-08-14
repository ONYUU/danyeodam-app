import {
  isAuthApiError,
  isAuthRetryableFetchError,
} from "@supabase/supabase-js";

import type { PublicErrorCode } from "@/server/http/api-error";

const rejectedCredentialCodes = new Set([
  "bad_jwt",
  "no_authorization",
  "session_expired",
  "session_not_found",
  "user_not_found",
  "user_banned",
]);

export function classifyAuthVerificationError(error: unknown): PublicErrorCode {
  if (isAuthRetryableFetchError(error)) {
    return "INTERNAL";
  }
  if (!isAuthApiError(error)) {
    return "INTERNAL";
  }
  if (error.status >= 500) {
    return "INTERNAL";
  }
  if (error.status === 401 || error.status === 403 || rejectedCredentialCodes.has(error.code ?? "")) {
    return "UNAUTHORIZED";
  }
  return "INTERNAL";
}
