import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAccessToken } from "@/server/auth/verify-access-token";
import { toApiError } from "@/server/http/api-error";
import { readLimitedJson } from "@/server/http/body";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import { parseMinimumAgeAttestationInput } from "@/server/minimum-age/input";
import {
  attestMinimumAge,
  readMinimumAgeAttestation,
} from "@/server/minimum-age/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId();
  try {
    const authUserId = await verifyAccessToken(requireBearerToken(request));
    const attestation = await readMinimumAgeAttestation(authUserId);
    return jsonSuccess({ attestation }, 200, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "minimum_age_status", category: "unexpected" });
    }
    return jsonError(apiError, requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId();
  try {
    const authUserId = await verifyAccessToken(requireBearerToken(request));
    const attestation = parseMinimumAgeAttestationInput(await readLimitedJson(request));
    await attestMinimumAge({ authUserId, attestation });
    return new Response(null, {
      status: 204,
      headers: { "X-Request-Id": requestId, "Cache-Control": "no-store" },
    });
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "minimum_age_attest", category: "unexpected" });
    }
    return jsonError(apiError, requestId);
  }
}
