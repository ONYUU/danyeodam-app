import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAccessToken } from "@/server/auth/verify-access-token";
import { toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { jsonError } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import { parseModerationId } from "@/server/moderation/input";
import { readModerationSharePhoto } from "@/server/moderation/service";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = createRequestId();
  try {
    const authUserId = await verifyAccessToken(requireBearerToken(request));
    const personalCardId = parseModerationId((await context.params).id);
    const photo = await readModerationSharePhoto({ authUserId, personalCardId });
    return new Response(photo.body, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": photo.contentType,
        "Content-Length": String(photo.contentLength),
        "X-Content-Type-Options": "nosniff",
        "X-Request-Id": requestId,
      },
    });
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "admin_share_moderation_photo", category: "unexpected" });
    }
    return jsonError(apiError, requestId);
  }
}
