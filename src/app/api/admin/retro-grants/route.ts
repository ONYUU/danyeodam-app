import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAccessToken } from "@/server/auth/verify-access-token";
import { grantRetroAcquisition, parseRetroGrantInput } from "@/server/admin/retro";
import { ApiError, toApiError } from "@/server/http/api-error";
import { readLimitedJson } from "@/server/http/body";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId();

  try {
    const authUserId = await verifyAccessToken(requireBearerToken(request));
    const grant = parseRetroGrantInput(await readLimitedJson(request));
    const result = await grantRetroAcquisition({ authUserId, grant });

    if (result.status === "unauthorized") {
      throw new ApiError("UNAUTHORIZED");
    }
    if (result.status === "forbidden") {
      throw new ApiError("FORBIDDEN");
    }
    if (result.status === "not_found") {
      throw new ApiError("NOT_FOUND");
    }
    return jsonSuccess(
      { acquisition: result.acquisition },
      result.status === "created" ? 201 : 200,
      requestId,
    );
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "admin_retro_grant", category: "unexpected" });
    }
    return jsonError(apiError, requestId);
  }
}
