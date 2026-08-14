import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAdultAccessToken } from "@/server/auth/verify-adult-access-token";
import {
  assertNoQueryParameters,
  parseBonusPackId,
} from "@/server/bonus-packs/input";
import { getBonusPack } from "@/server/bonus-packs/service";
import { toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = createRequestId();
  try {
    const authUserId = await verifyAdultAccessToken(requireBearerToken(request));
    assertNoQueryParameters(request.url);
    const { id } = await context.params;
    const result = await getBonusPack({
      authUserId,
      bonusPackId: parseBonusPackId(id),
    });
    return jsonSuccess(result, 200, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({
        requestId,
        operation: "get_bonus_pack",
        category: "unexpected",
      });
    }
    return jsonError(apiError, requestId);
  }
}
