import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAdultAccessToken } from "@/server/auth/verify-adult-access-token";
import { getServerEnvironment, isPublicRecruitmentOpen } from "@/server/env";
import { parseClientEventBatch } from "@/server/events/input";
import { ingestClientEvents } from "@/server/events/repository";
import { ApiError, toApiError } from "@/server/http/api-error";
import { readLimitedJson } from "@/server/http/body";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId();

  try {
    const authUserId = await verifyAdultAccessToken(requireBearerToken(request));
    const events = parseClientEventBatch(await readLimitedJson(request, 32_768));
    const environment = getServerEnvironment();
    const result = await ingestClientEvents({
      authUserId,
      publicGateOpen: isPublicRecruitmentOpen(environment.PUBLIC_RECRUIT_GATE),
      events,
    });

    if (result.status === "unauthorized") {
      throw new ApiError("UNAUTHORIZED");
    }
    if (result.status === "gate_closed") {
      throw new ApiError("GATE_CLOSED");
    }
    if (result.status === "invalid") {
      throw new ApiError("VALIDATION_FAILED");
    }
    return jsonSuccess({
      accepted: result.accepted,
      duplicates: result.duplicates,
    }, 202, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({
        requestId,
        operation: "events_ingest",
        category: "unexpected",
      });
    }
    return jsonError(apiError, requestId);
  }
}
