import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAdultAccessToken } from "@/server/auth/verify-adult-access-token";
import { getServerEnvironment, isPublicRecruitmentOpen } from "@/server/env";
import { toApiError } from "@/server/http/api-error";
import { readLimitedJson } from "@/server/http/body";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import { parsePersonalCardUploadInput } from "@/server/personal-cards/input";
import { issuePersonalCardUpload } from "@/server/personal-cards/service";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId();

  try {
    const authUserId = await verifyAdultAccessToken(requireBearerToken(request));
    const upload = parsePersonalCardUploadInput(await readLimitedJson(request));
    const environment = getServerEnvironment();
    const result = await issuePersonalCardUpload({
      authUserId,
      publicGateOpen: isPublicRecruitmentOpen(environment.PUBLIC_RECRUIT_GATE),
      upload,
    });

    return jsonSuccess(result, 200, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({
        requestId,
        operation: "personal_card_upload_url",
        category: "unexpected",
      });
    }
    const retryAfter = apiError.code === "RATE_LIMITED"
      ? apiError.details?.retry_after_seconds
      : undefined;
    return jsonError(
      apiError,
      requestId,
      typeof retryAfter === "number" ? { "Retry-After": String(retryAfter) } : undefined,
    );
  }
}
