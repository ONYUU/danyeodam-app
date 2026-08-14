import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAdultAccessToken } from "@/server/auth/verify-adult-access-token";
import { getServerEnvironment, isPublicRecruitmentOpen } from "@/server/env";
import { toApiError } from "@/server/http/api-error";
import { readLimitedJson } from "@/server/http/body";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import { parsePersonalCardPromotionInput } from "@/server/personal-cards/input";
import { promotePersonalCard } from "@/server/personal-cards/service";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId();

  try {
    const authUserId = await verifyAdultAccessToken(requireBearerToken(request));
    const promotion = parsePersonalCardPromotionInput(await readLimitedJson(request));
    const environment = getServerEnvironment();
    const result = await promotePersonalCard({
      authUserId,
      publicGateOpen: isPublicRecruitmentOpen(environment.PUBLIC_RECRUIT_GATE),
      promotion,
    });

    return jsonSuccess(result, 201, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({
        requestId,
        operation: "personal_card_promote",
        category: "unexpected",
      });
    }
    return jsonError(apiError, requestId);
  }
}
