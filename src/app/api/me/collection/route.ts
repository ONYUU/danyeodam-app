import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAdultAccessToken } from "@/server/auth/verify-adult-access-token";
import { parseCollectionQuery } from "@/server/collection/input";
import { readCollection } from "@/server/collection/service";
import { getServerEnvironment } from "@/server/env";
import { toApiError, ApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId();
  try {
    const authUserId = await verifyAdultAccessToken(requireBearerToken(request));
    const query = parseCollectionQuery(request.url);
    const environment = getServerEnvironment();
    if (environment.COLLECTION_CURSOR_SECRET === undefined) {
      throw new ApiError("INTERNAL");
    }
    const body = await readCollection({
      authUserId,
      limit: query.limit,
      cursor: query.cursor,
      cursorSecret: environment.COLLECTION_CURSOR_SECRET,
      publicAppUrl: environment.PUBLIC_APP_URL,
    });
    return jsonSuccess(body, 200, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "collection", category: "unexpected" });
    }
    return jsonError(apiError, requestId);
  }
}
