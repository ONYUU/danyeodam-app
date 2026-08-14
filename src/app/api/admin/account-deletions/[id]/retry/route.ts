import {
  parseAccountDeletionAdminRequestId,
  parseAccountDeletionAdminRetryInput,
} from "@/server/account-deletion/admin-input";
import { retryAccountDeletionJobAdmin } from "@/server/account-deletion/repository";
import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAccessToken } from "@/server/auth/verify-access-token";
import { toApiError } from "@/server/http/api-error";
import { readLimitedJson } from "@/server/http/body";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = createRequestId();
  try {
    const adminAuthUserId = await verifyAccessToken(requireBearerToken(request));
    const deletionRequestId = parseAccountDeletionAdminRequestId(
      (await context.params).id,
    );
    const input = parseAccountDeletionAdminRetryInput(await readLimitedJson(request));
    const retry = await retryAccountDeletionJobAdmin({
      adminAuthUserId,
      requestId: deletionRequestId,
      clientActionId: input.client_action_id,
      reasonCode: input.reason_code,
      note: input.note,
    });
    return jsonSuccess(
      { retry },
      retry.status === "retry_scheduled" ? 202 : 200,
      requestId,
    );
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({
        requestId,
        operation: "account_deletion_admin_retry",
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
