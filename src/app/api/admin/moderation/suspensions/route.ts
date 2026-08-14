import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAccessToken } from "@/server/auth/verify-access-token";
import { toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import { parseSuspensionQueueQuery } from "@/server/moderation/input";
import { readShareOwnerSuspensions } from "@/server/moderation/service";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId();
  try {
    const authUserId = await verifyAccessToken(requireBearerToken(request));
    const query = parseSuspensionQueueQuery(new URL(request.url));
    const items = await readShareOwnerSuspensions({ authUserId, ...query });
    return jsonSuccess({ items }, 200, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "admin_suspension_queue", category: "unexpected" });
    }
    return jsonError(apiError, requestId);
  }
}
