import { ApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import { readPublicReleaseState } from "@/server/release-state";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const requestId = createRequestId();
  try {
    return jsonSuccess(readPublicReleaseState(), 200, requestId, {
      "X-Content-Type-Options": "nosniff",
    });
  } catch {
    logSafeServerError({
      requestId,
      operation: "public_release_state",
      category: "configuration",
    });
    return jsonError(new ApiError("NOT_FOUND"), requestId, {
      "X-Content-Type-Options": "nosniff",
    });
  }
}
