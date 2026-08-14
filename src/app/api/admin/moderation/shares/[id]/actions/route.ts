import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAccessToken } from "@/server/auth/verify-access-token";
import { getServerEnvironment, isPublicSharePublicationOpen } from "@/server/env";
import { toApiError } from "@/server/http/api-error";
import { readLimitedJson } from "@/server/http/body";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import { parseModerationId, parseShareModerationAction } from "@/server/moderation/input";
import { applyShareModerationAction } from "@/server/moderation/service";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = createRequestId();
  try {
    const authUserId = await verifyAccessToken(requireBearerToken(request));
    const personalCardId = parseModerationId((await context.params).id);
    const action = parseShareModerationAction(await readLimitedJson(request));
    const publicSharePublicationOpen = isPublicSharePublicationOpen(
      getServerEnvironment().PUBLIC_SHARE_PUBLICATION,
    );
    const result = await applyShareModerationAction({
      authUserId,
      personalCardId,
      action,
      publicSharePublicationOpen,
    });
    return jsonSuccess({ moderation: result }, 200, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "admin_share_moderation_action", category: "unexpected" });
    }
    return jsonError(apiError, requestId);
  }
}
