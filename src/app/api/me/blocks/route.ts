import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAdultAccessToken } from "@/server/auth/verify-adult-access-token";
import { parseBlockListQuery } from "@/server/blocks/input";
import { readUserBlocks } from "@/server/blocks/service";
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
    const query = parseBlockListQuery(request.url);
    const cursorSecret = getServerEnvironment().COLLECTION_CURSOR_SECRET;
    if (cursorSecret === undefined) throw new ApiError("INTERNAL");
    const result = await readUserBlocks({
      authUserId,
      limit: query.limit,
      cursor: query.cursor,
      cursorSecret,
    });
    return jsonSuccess({ blocks: result.items, page: result.page }, 200, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "list_user_blocks", category: "unexpected" });
    }
    return jsonError(apiError, requestId);
  }
}
