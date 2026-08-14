import {
  parseDeletionRequestInput,
} from "@/server/account-deletion/input";
import { requestAccountDeletion } from "@/server/account-deletion/repository";
import { hashAccountDeletionSecret } from "@/server/account-deletion/secret";
import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifySupabaseAccessTokenUser } from "@/server/auth/verify-access-token";
import { ApiError, toApiError } from "@/server/http/api-error";
import { readLimitedJson } from "@/server/http/body";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId();

  try {
    const authUser = await verifySupabaseAccessTokenUser(requireBearerToken(request));
    const input = parseDeletionRequestInput(await readLimitedJson(request));
    const result = await requestAccountDeletion({
      authUserId: authUser.id,
      requestId: input.client_request_id,
      statusTokenHashHex: hashAccountDeletionSecret(input.status_token),
    });

    if (result.status === "accepted") {
      return jsonSuccess({ deletion_request: result.deletion_request }, 202, requestId);
    }
    if (
      result.status === "idempotency_conflict"
      || result.status === "already_requested"
    ) {
      throw new ApiError("IDEMPOTENCY_CONFLICT");
    }
    throw new ApiError("UNAUTHORIZED");
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({
        requestId,
        operation: "account_deletion_request",
        category: "unexpected",
      });
    }
    return jsonError(apiError, requestId);
  }
}
