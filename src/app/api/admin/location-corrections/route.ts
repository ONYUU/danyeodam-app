import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAccessToken } from "@/server/auth/verify-access-token";
import { ApiError, toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { readLocationCorrectionQueue } from "@/server/location/admin";
import { logSafeServerError } from "@/server/logging/safe-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId();
  try {
    const adminAuthUserId = await verifyAccessToken(requireBearerToken(request));
    const url = new URL(request.url);
    const status = url.searchParams.get("status") ?? "open";
    const limit = Number(url.searchParams.get("limit") ?? "50");
    if (
      !["open", "approved_pending_correction", "corrected", "rejected"].includes(status)
      || !Number.isInteger(limit)
      || limit < 1
      || limit > 100
    ) {
      throw new ApiError("VALIDATION_FAILED");
    }
    const items = await readLocationCorrectionQueue({
      adminAuthUserId,
      status: status as "open" | "approved_pending_correction" | "corrected" | "rejected",
      limit,
    });
    return jsonSuccess({ items }, 200, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "location_correction_admin", category: "unexpected" });
    }
    return jsonError(apiError, requestId);
  }
}
