import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAdultAccessToken } from "@/server/auth/verify-adult-access-token";
import { getServerEnvironment, isPublicRecruitmentOpen } from "@/server/env";
import { ApiError, toApiError } from "@/server/http/api-error";
import { readLimitedJson } from "@/server/http/body";
import { createRequestId } from "@/server/http/request-id";
import { emptySuccess, jsonError } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import { parsePhysicalRequestInput } from "@/server/physical-requests/input";
import { createPhysicalRequest } from "@/server/physical-requests/repository";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId();

  try {
    const authUserId = await verifyAdultAccessToken(requireBearerToken(request));
    const input = parsePhysicalRequestInput(await readLimitedJson(request));
    const environment = getServerEnvironment();
    const result = await createPhysicalRequest({
      authUserId,
      publicGateOpen: isPublicRecruitmentOpen(environment.PUBLIC_RECRUIT_GATE),
      kind: input.kind,
    });

    if (result.status === "unauthorized") {
      throw new ApiError("UNAUTHORIZED");
    }
    if (result.status === "gate_closed") {
      throw new ApiError("GATE_CLOSED");
    }
    return emptySuccess(204, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({
        requestId,
        operation: "physical_request",
        category: "unexpected",
      });
    }
    return jsonError(apiError, requestId);
  }
}
