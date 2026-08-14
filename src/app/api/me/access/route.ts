import { getAccessProjection } from "@/server/access/repository";
import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAdultAccessToken } from "@/server/auth/verify-adult-access-token";
import { ApiError, toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId();

  try {
    const authUserId = await verifyAdultAccessToken(requireBearerToken(request));
    const projection = await getAccessProjection(authUserId);
    if (projection.status === "unauthorized") {
      throw new ApiError("UNAUTHORIZED");
    }

    return jsonSuccess({
      participant: projection.participant,
      access_type: projection.access_type,
      field_acquisition_requires_location:
        projection.field_acquisition_requires_location,
      fixture_version: projection.fixture_version,
    }, 200, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({
        requestId,
        operation: "access_projection",
        category: "unexpected",
      });
    }
    return jsonError(apiError, requestId);
  }
}
