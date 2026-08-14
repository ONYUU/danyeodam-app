import { contentVersionEtag, ifNoneMatchMatches } from "@/server/http/etag";
import { toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { jsonError } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import { readPublicSpots } from "@/server/spots/service";

export const runtime = "nodejs";

const cacheControl = "public, max-age=0, must-revalidate";

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId();
  try {
    const body = await readPublicSpots();
    const etag = contentVersionEtag(body.content_version);
    const headers = {
      "Cache-Control": cacheControl,
      ETag: etag,
      "X-Request-Id": requestId,
    };
    if (ifNoneMatchMatches(request.headers.get("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers });
    }
    return Response.json(body, {
      status: 200,
      headers: {
        ...headers,
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "public_spots", category: "unexpected" });
    }
    return jsonError(apiError, requestId);
  }
}
