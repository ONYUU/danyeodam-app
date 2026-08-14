import { getServerEnvironment } from "@/server/env";
import { ApiError, toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import { hasValidCronAuthorization } from "@/server/personal-cards/cron-auth";
import { cleanupExpiredPersonalCardUploads } from "@/server/personal-cards/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId();

  try {
    const environment = getServerEnvironment();
    if (!hasValidCronAuthorization(
      request.headers.get("authorization"),
      environment.CRON_SECRET,
    )) {
      throw new ApiError("UNAUTHORIZED");
    }

    const result = await cleanupExpiredPersonalCardUploads();
    if (
      result.promotion_expired.failed > 0
      || result.signed_url_expired.failed > 0
      || result.permanent.failed > 0
      || result.backlog.overdue_15m > 0
    ) {
      throw new ApiError("INTERNAL");
    }
    return jsonSuccess(result, 200, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({
        requestId,
        operation: "personal_card_temp_cleanup",
        category: "unexpected",
      });
    }
    return jsonError(apiError, requestId);
  }
}
