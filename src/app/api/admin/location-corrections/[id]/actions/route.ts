import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAccessToken } from "@/server/auth/verify-access-token";
import { toApiError } from "@/server/http/api-error";
import { readLimitedJson } from "@/server/http/body";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { resolveLocationCorrection } from "@/server/location/admin";
import {
  parseLocationCorrectionRequestId,
  parseLocationCorrectionResolutionInput,
} from "@/server/location/input";
import { logSafeServerError } from "@/server/logging/safe-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = createRequestId();
  try {
    const adminAuthUserId = await verifyAccessToken(requireBearerToken(request));
    const { id: rawId } = await context.params;
    const id = parseLocationCorrectionRequestId(rawId);
    const { resolution } = parseLocationCorrectionResolutionInput(await readLimitedJson(request));
    const result = await resolveLocationCorrection({
      adminAuthUserId,
      correctionRequestId: id,
      resolution,
    });
    return jsonSuccess(result, result.status === "correction_pending" ? 202 : 200, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "location_correction_resolve", category: "unexpected" });
    }
    return jsonError(apiError, requestId);
  }
}
