import { getServerEnvironment } from "@/server/env";
import { readLimitedJson } from "@/server/http/body";
import { ApiError, toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { jsonError } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import {
  clearAgeAttestationSetCookie,
  createAgeAttestationSetCookie,
} from "@/server/public-shares/age-attestation";
import { publicShareResponseHeaders } from "@/server/public-shares/headers";
import { parseAgeAttestationInput } from "@/server/public-shares/input";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId();
  const securityHeaders = publicShareResponseHeaders();

  try {
    const input = parseAgeAttestationInput(await readLimitedJson(request, 128));
    const secret = getServerEnvironment().ABUSE_HMAC_SECRET;
    if (secret === undefined) {
      throw new ApiError("INTERNAL");
    }
    const headers = publicShareResponseHeaders({
      "Set-Cookie": input.pass
        ? createAgeAttestationSetCookie(secret)
        : clearAgeAttestationSetCookie(),
      "X-Request-Id": requestId,
    });
    return new Response(null, { status: 204, headers });
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "public_share_age_attestation", category: "unexpected" });
    }
    return jsonError(apiError, requestId, securityHeaders);
  }
}
