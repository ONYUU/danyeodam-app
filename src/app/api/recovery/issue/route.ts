import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAdultAccessToken } from "@/server/auth/verify-adult-access-token";
import { ApiError, toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import { createRecoveryCode, hashRecoveryCode } from "@/server/recovery/code";
import { issueRecoveryCode } from "@/server/recovery/repository";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId();

  try {
    const authUserId = await verifyAdultAccessToken(requireBearerToken(request));
    const code = createRecoveryCode();
    const result = await issueRecoveryCode({
      authUserId,
      codeHashHex: hashRecoveryCode(code),
    });

    if (result.status === "unauthorized") {
      throw new ApiError("UNAUTHORIZED");
    }
    if (result.status === "no_acquisition") {
      throw new ApiError("FORBIDDEN");
    }
    if (result.status === "reviewer_forbidden") {
      throw new ApiError("FORBIDDEN");
    }
    return jsonSuccess({ code }, 201, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({
        requestId,
        operation: "recovery_issue",
        category: "unexpected",
      });
    }
    return jsonError(apiError, requestId);
  }
}
