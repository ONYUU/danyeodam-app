import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAdultAccessToken } from "@/server/auth/verify-adult-access-token";
import { blockShareOwner } from "@/server/blocks/service";
import { getServerEnvironment, isPublicSharePublicationOpen } from "@/server/env";
import { readLimitedJson } from "@/server/http/body";
import { ApiError, toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { emptySuccess, jsonError } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import { publicShareResponseHeaders } from "@/server/public-shares/headers";
import { parsePublicShareBlockInput } from "@/server/public-shares/input";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId();
  const securityHeaders = publicShareResponseHeaders();

  try {
    const publicSharePublicationOpen = isPublicSharePublicationOpen(
      getServerEnvironment().PUBLIC_SHARE_PUBLICATION,
    );
    if (!publicSharePublicationOpen) {
      throw new ApiError("NOT_FOUND");
    }
    const authUserId = await verifyAdultAccessToken(requireBearerToken(request));
    const input = parsePublicShareBlockInput(await readLimitedJson(request, 512));
    await blockShareOwner({
      authUserId,
      shareSlug: input.shareSecret,
      clientActionId: input.clientActionId,
      publicSharePublicationOpen,
    });
    return emptySuccess(204, requestId, securityHeaders);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "block_share_owner", category: "unexpected" });
    }
    const retryAfter = apiError.code === "RATE_LIMITED"
      ? apiError.details?.retry_after_seconds
      : undefined;
    return jsonError(
      apiError,
      requestId,
      publicShareResponseHeaders(
        typeof retryAfter === "number" ? { "Retry-After": String(retryAfter) } : undefined,
      ),
    );
  }
}
