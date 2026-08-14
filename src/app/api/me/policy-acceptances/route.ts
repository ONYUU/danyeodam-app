import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAdultAccessToken } from "@/server/auth/verify-adult-access-token";
import { readLimitedJson } from "@/server/http/body";
import { toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { emptySuccess, jsonError } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import { parsePolicyAcceptanceInput } from "@/server/policies/input";
import { recordPolicyAcceptances } from "@/server/policies/service";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId();
  try {
    const authUserId = await verifyAdultAccessToken(requireBearerToken(request));
    const acceptance = parsePolicyAcceptanceInput(await readLimitedJson(request));
    await recordPolicyAcceptances({ authUserId, acceptance });
    return emptySuccess(204, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "policy_acceptance", category: "unexpected" });
    }
    return jsonError(apiError, requestId);
  }
}
