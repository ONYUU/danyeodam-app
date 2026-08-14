import { z } from "zod";

import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAdultAccessToken } from "@/server/auth/verify-adult-access-token";
import { ApiError, toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { jsonError } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import { readOwnedPersonalCardPhoto } from "@/server/personal-cards/photo-service";

export const runtime = "nodejs";

const personalCardIdSchema = z.uuid();

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = createRequestId();
  try {
    const authUserId = await verifyAdultAccessToken(requireBearerToken(request));
    const parsedId = personalCardIdSchema.safeParse((await context.params).id);
    if (!parsedId.success) {
      throw new ApiError("NOT_FOUND");
    }
    const photo = await readOwnedPersonalCardPhoto({
      authUserId,
      personalCardId: parsedId.data,
    });
    return new Response(photo.body, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": photo.contentType,
        "Content-Length": String(photo.contentLength),
        "X-Content-Type-Options": "nosniff",
        "X-Request-Id": requestId,
      },
    });
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "personal_card_photo", category: "unexpected" });
    }
    return jsonError(apiError, requestId);
  }
}
