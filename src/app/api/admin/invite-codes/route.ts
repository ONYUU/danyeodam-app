import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAccessToken } from "@/server/auth/verify-access-token";
import { ApiError, toApiError } from "@/server/http/api-error";
import { readLimitedJson } from "@/server/http/body";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import { createInviteCode, hashInviteCode } from "@/server/participants/code";
import { parseIssueParticipantInvitesInput } from "@/server/participants/input";
import { issueParticipantInvites } from "@/server/participants/repository";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId();

  try {
    const authUserId = await verifyAccessToken(requireBearerToken(request));
    const input = parseIssueParticipantInvitesInput(await readLimitedJson(request));
    const codes = Array.from({ length: input.count }, createInviteCode);
    const result = await issueParticipantInvites({
      authUserId,
      codeHashHexes: codes.map(hashInviteCode),
      note: input.note,
    });

    if (result.status === "unauthorized") {
      throw new ApiError("UNAUTHORIZED");
    }
    if (result.status === "forbidden") {
      throw new ApiError("FORBIDDEN");
    }
    if (result.count !== codes.length) {
      throw new ApiError("INTERNAL");
    }

    return jsonSuccess({ codes }, 201, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({
        requestId,
        operation: "admin_invite_codes",
        category: "unexpected",
      });
    }
    return jsonError(apiError, requestId);
  }
}
