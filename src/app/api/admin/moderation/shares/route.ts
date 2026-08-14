import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAccessToken } from "@/server/auth/verify-access-token";
import { toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import { parseShareQueueQuery } from "@/server/moderation/input";
import { readShareModerationQueue } from "@/server/moderation/service";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId();
  try {
    const authUserId = await verifyAccessToken(requireBearerToken(request));
    const query = parseShareQueueQuery(new URL(request.url));
    const items = await readShareModerationQueue({ authUserId, ...query });
    return jsonSuccess({ items }, 200, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "admin_share_moderation_queue", category: "unexpected" });
    }
    return jsonError(apiError, requestId);
  }
}
