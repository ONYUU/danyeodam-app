import { requestEmailLink } from "@/server/auth/link-email";
import { parseLinkEmailInput } from "@/server/auth/link-email-input";
import { getEmailLinkEligibility } from "@/server/access/repository";
import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAdultAccessTokenUser } from "@/server/auth/verify-adult-access-token";
import { ApiError, toApiError } from "@/server/http/api-error";
import { readLimitedJson } from "@/server/http/body";
import { createRequestId } from "@/server/http/request-id";
import { emptySuccess, jsonError } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId();

  try {
    const token = requireBearerToken(request);
    const authUser = await verifyAdultAccessTokenUser(token);
    const eligibility = await getEmailLinkEligibility(authUser.id);
    if (eligibility.status === "unauthorized") {
      throw new ApiError("UNAUTHORIZED");
    }
    if (eligibility.status === "reviewer_forbidden") {
      throw new ApiError("FORBIDDEN");
    }
    if (!authUser.isAnonymous) {
      throw new ApiError("FORBIDDEN");
    }
    const input = parseLinkEmailInput(await readLimitedJson(request));
    await requestEmailLink(token, input);
    return emptySuccess(204, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({
        requestId,
        operation: "link_email",
        category: "unexpected",
      });
    }
    return jsonError(apiError, requestId);
  }
}
