import { verifyOptionalAccessToken } from "@/server/auth/optional-access-token";
import { readLimitedJson } from "@/server/http/body";
import { toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import { requirePublicShareAccess } from "@/server/public-shares/access";
import { publicShareResponseHeaders } from "@/server/public-shares/headers";
import { parsePublicShareSecretInput } from "@/server/public-shares/input";
import { readPublicShare } from "@/server/shares/service";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId();
  const securityHeaders = publicShareResponseHeaders();

  try {
    const { publicSharePublicationOpen } = requirePublicShareAccess(request);
    const viewerAuthUserId = await verifyOptionalAccessToken(request);
    const shareSlug = parsePublicShareSecretInput(await readLimitedJson(request, 512));
    return jsonSuccess(
      await readPublicShare({ shareSlug, viewerAuthUserId, publicSharePublicationOpen }),
      200,
      requestId,
      securityHeaders,
    );
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "public_share_resolve", category: "unexpected" });
    }
    return jsonError(apiError, requestId, securityHeaders);
  }
}
