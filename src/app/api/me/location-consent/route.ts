import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyActiveIdentityAccessToken } from "@/server/auth/verify-active-identity-access-token";
import { verifyAdultAccessToken } from "@/server/auth/verify-adult-access-token";
import { toApiError } from "@/server/http/api-error";
import { readLimitedJson } from "@/server/http/body";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import {
  parseLocationConsentInput,
  parseLocationConsentStateInput,
} from "@/server/location/input";
import {
  consentToLocation,
  readLocationConsent,
  setLocationConsentState,
  withdrawLocationConsent,
} from "@/server/location/service";
import { logSafeServerError } from "@/server/logging/safe-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function adultAuth(request: Request): Promise<string> {
  return verifyAdultAccessToken(requireBearerToken(request));
}

async function privacyRightsAuth(request: Request): Promise<string> {
  return verifyActiveIdentityAccessToken(requireBearerToken(request));
}

function failure(error: unknown, requestId: string, operation: string): Response {
  const apiError = toApiError(error);
  if (apiError.code === "INTERNAL") {
    logSafeServerError({ requestId, operation, category: "unexpected" });
  }
  return jsonError(apiError, requestId);
}

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId();
  try {
    const result = await readLocationConsent(await privacyRightsAuth(request));
    return jsonSuccess(result, 200, requestId);
  } catch (error) {
    return failure(error, requestId, "location_consent_status");
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId();
  try {
    const authUserId = await adultAuth(request);
    const acceptance = parseLocationConsentInput(await readLimitedJson(request));
    await consentToLocation({ authUserId, acceptance });
    return new Response(null, {
      status: 204,
      headers: { "X-Request-Id": requestId, "Cache-Control": "no-store" },
    });
  } catch (error) {
    return failure(error, requestId, "location_consent_accept");
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const requestId = createRequestId();
  try {
    const { state } = parseLocationConsentStateInput(await readLimitedJson(request));
    const authUserId = state === "active"
      ? await adultAuth(request)
      : await privacyRightsAuth(request);
    await setLocationConsentState({ authUserId, state });
    return new Response(null, {
      status: 204,
      headers: { "X-Request-Id": requestId, "Cache-Control": "no-store" },
    });
  } catch (error) {
    return failure(error, requestId, "location_consent_state");
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const requestId = createRequestId();
  try {
    const result = await withdrawLocationConsent(await privacyRightsAuth(request));
    if (result.erasure_job_id === null) {
      return new Response(null, {
        status: 204,
        headers: { "X-Request-Id": requestId, "Cache-Control": "no-store" },
      });
    }
    return jsonSuccess(result, 202, requestId);
  } catch (error) {
    return failure(error, requestId, "location_consent_withdraw");
  }
}
