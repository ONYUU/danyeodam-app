import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAccessToken } from "@/server/auth/verify-access-token";
import { toApiError } from "@/server/http/api-error";
import { readLimitedJson } from "@/server/http/body";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import {
  parseReviewerAppUserId,
  parseReviewerLifecycleActionInput,
} from "@/server/reviewer-access/input";
import { revokeReviewerAccess } from "@/server/reviewer-access/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ appUserId: string }> },
): Promise<Response> {
  const requestId = createRequestId();
  try {
    const adminAuthUserId = await verifyAccessToken(requireBearerToken(request));
    const appUserId = parseReviewerAppUserId((await context.params).appUserId);
    const input = parseReviewerLifecycleActionInput(await readLimitedJson(request));
    const reviewerAccess = await revokeReviewerAccess({
      adminAuthUserId,
      appUserId,
      clientActionId: input.client_action_id,
    });
    return jsonSuccess({ reviewer_access: reviewerAccess }, 200, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({
        requestId,
        operation: "reviewer_access_revoke",
        category: "unexpected",
      });
    }
    return jsonError(apiError, requestId);
  }
}
