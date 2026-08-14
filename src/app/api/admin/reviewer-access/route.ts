import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAccessToken } from "@/server/auth/verify-access-token";
import { toApiError } from "@/server/http/api-error";
import { readLimitedJson } from "@/server/http/body";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import { parseReviewerProvisionInput } from "@/server/reviewer-access/input";
import { provisionReviewerAccess } from "@/server/reviewer-access/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId();
  try {
    const adminAuthUserId = await verifyAccessToken(requireBearerToken(request));
    const input = parseReviewerProvisionInput(await readLimitedJson(request));
    const reviewerAccess = await provisionReviewerAccess({
      adminAuthUserId,
      appUserId: input.app_user_id,
      storePlatform: input.store_platform,
      fixtureVersion: input.fixture_version,
      clientActionId: input.client_action_id,
    });
    return jsonSuccess({ reviewer_access: reviewerAccess }, 201, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({
        requestId,
        operation: "reviewer_access_provision",
        category: "unexpected",
      });
    }
    return jsonError(apiError, requestId);
  }
}
