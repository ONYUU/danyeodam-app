import { z } from "zod";

import { downloadPublishedCardAsset } from "@/server/cards/assets";
import { ApiError, toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { jsonError } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";

export const runtime = "nodejs";

const cardIdSchema = z.uuid();

export async function GET(
  _request: Request,
  context: { params: Promise<{ cardId: string }> },
): Promise<Response> {
  const requestId = createRequestId();

  try {
    const { cardId: rawCardId } = await context.params;
    const cardId = cardIdSchema.safeParse(rawCardId);
    if (!cardId.success) {
      return jsonError(new ApiError("NOT_FOUND"), requestId);
    }

    const asset = await downloadPublishedCardAsset(cardId.data);
    return new Response(asset.body, {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
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
        operation: "card_asset",
        category: "unexpected",
      });
    }
    return jsonError(apiError, requestId);
  }
}
