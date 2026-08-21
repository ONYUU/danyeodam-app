import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAdultAccessToken } from "@/server/auth/verify-adult-access-token";
import { downloadOwnedSpecialCardAsset } from "@/server/bonus-packs/assets";
import {
  assertNoQueryParameters,
  parseSpecialCardId,
} from "@/server/bonus-packs/input";
import { toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { jsonError } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ cardId: string }> },
): Promise<Response> {
  const requestId = createRequestId();
  try {
    const authUserId = await verifyAdultAccessToken(requireBearerToken(request));
    assertNoQueryParameters(request.url);
    const { cardId: rawCardId } = await context.params;
    const asset = await downloadOwnedSpecialCardAsset({
      authUserId,
      cardId: parseSpecialCardId(rawCardId),
    });
    return new Response(asset.body, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": asset.contentType,
        ...(asset.contentLength === undefined
          ? {}
          : { "Content-Length": String(asset.contentLength) }),
        "X-Content-Type-Options": "nosniff",
        "X-Request-Id": requestId,
      },
    });
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({
        requestId,
        operation: "owned_special_card_asset",
        category: "unexpected",
      });
    }
    return jsonError(apiError, requestId);
  }
}
