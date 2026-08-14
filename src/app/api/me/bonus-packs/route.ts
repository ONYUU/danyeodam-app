import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAdultAccessToken } from "@/server/auth/verify-adult-access-token";
import { parseBonusPackListQuery } from "@/server/bonus-packs/input";
import { listBonusPacks } from "@/server/bonus-packs/service";
import { getServerEnvironment } from "@/server/env";
import { ApiError, toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId();
  try {
    const authUserId = await verifyAdultAccessToken(requireBearerToken(request));
    const query = parseBonusPackListQuery(request.url);
    const cursorSecret = getServerEnvironment().BONUS_PACK_CURSOR_SECRET;
    if (cursorSecret === undefined) throw new ApiError("INTERNAL");
    const result = await listBonusPacks({
      authUserId,
      limit: query.limit,
      cursor: query.cursor,
      cursorSecret,
    });
    return jsonSuccess(result, 200, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({
        requestId,
        operation: "list_bonus_packs",
        category: "unexpected",
      });
    }
    return jsonError(apiError, requestId);
  }
}
