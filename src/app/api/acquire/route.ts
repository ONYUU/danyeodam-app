import { acquireCard } from "@/server/acquire/service";
import { parseAcquireInput } from "@/server/acquire/input";
import { SupabaseAcquireRepository } from "@/server/acquire/repository";
import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAdultAccessToken } from "@/server/auth/verify-adult-access-token";
import { getServerEnvironment, isPublicRecruitmentOpen } from "@/server/env";
import { toApiError } from "@/server/http/api-error";
import { readLimitedJson } from "@/server/http/body";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId();

  try {
    const token = requireBearerToken(request);
    const authUserId = await verifyAdultAccessToken(token);
    const input = parseAcquireInput(await readLimitedJson(request));
    const environment = getServerEnvironment();
    const repository = new SupabaseAcquireRepository();

    const outcome = await acquireCard(
      input,
      {
        authUserId,
        publicGateOpen: isPublicRecruitmentOpen(environment.PUBLIC_RECRUIT_GATE),
      },
      {
        repository,
      },
    );

    return jsonSuccess(outcome.body, outcome.status, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({
        requestId,
        operation: "acquire",
        category: "unexpected",
      });
    }
    return jsonError(apiError, requestId);
  }
}
