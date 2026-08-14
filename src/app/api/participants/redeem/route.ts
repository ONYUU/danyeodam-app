import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAdultAccessToken } from "@/server/auth/verify-adult-access-token";
import { ApiError, toApiError } from "@/server/http/api-error";
import { readLimitedJson } from "@/server/http/body";
import { createRequestId } from "@/server/http/request-id";
import { emptySuccess, jsonError } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import { hashInviteCode } from "@/server/participants/code";
import { parseRedeemParticipantInput } from "@/server/participants/input";
import { redeemParticipantInvite } from "@/server/participants/repository";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId();

  try {
    const authUserId = await verifyAdultAccessToken(requireBearerToken(request));
    const input = parseRedeemParticipantInput(await readLimitedJson(request));
    const result = await redeemParticipantInvite({
      authUserId,
      codeHashHex: hashInviteCode(input.invite_code),
    });

    if (result.status === "redeemed") {
      return emptySuccess(204, requestId);
    }
    if (result.status === "rate_limited") {
      throw new ApiError("RATE_LIMITED", { locked_minutes: result.locked_minutes });
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
        operation: "participant_redeem",
        category: "unexpected",
      });
    }
    return jsonError(apiError, requestId);
  }
}
