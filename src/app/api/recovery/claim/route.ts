import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAdultAccessToken } from "@/server/auth/verify-adult-access-token";
import { ApiError, toApiError } from "@/server/http/api-error";
import { readLimitedJson } from "@/server/http/body";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import { hashRecoveryCode } from "@/server/recovery/code";
import { parseClaimRecoveryInput } from "@/server/recovery/input";
import { claimRecoveryCode } from "@/server/recovery/repository";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId();

  try {
    const authUserId = await verifyAdultAccessToken(requireBearerToken(request));
    const input = parseClaimRecoveryInput(await readLimitedJson(request));
    const result = await claimRecoveryCode({
      authUserId,
      codeHashHex: hashRecoveryCode(input.code),
    });

    if (result.status === "restored") {
      return jsonSuccess({ restored: true }, 200, requestId);
    }
    if (result.status === "rate_limited") {
      throw new ApiError("RATE_LIMITED", { locked_minutes: result.locked_minutes });
    }
    if (result.status === "not_empty") {
      throw new ApiError("RECOVERY_CONFLICT", { reason: "not_empty" });
    }
    if (result.status === "not_anonymous") {
      throw new ApiError("FORBIDDEN");
    }
    if (result.status === "unauthorized") {
      throw new ApiError("UNAUTHORIZED");
    }
    throw new ApiError("NOT_FOUND");
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({
        requestId,
        operation: "recovery_claim",
        category: "unexpected",
      });
    }
    return jsonError(apiError, requestId);
  }
}
