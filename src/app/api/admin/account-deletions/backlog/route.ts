import {
  getAccountDeletionBacklogAdmin,
  type AccountDeletionBacklog,
} from "@/server/account-deletion/repository";
import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAccessToken } from "@/server/auth/verify-access-token";
import { ApiError, toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId();
  try {
    if ([...new URL(request.url).searchParams].length > 0) {
      throw new ApiError("VALIDATION_FAILED");
    }
    const adminAuthUserId = await verifyAccessToken(requireBearerToken(request));
    const result = await getAccountDeletionBacklogAdmin(adminAuthUserId);
    const backlog = withoutStatus(result);
    return jsonSuccess({ backlog }, 200, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({
        requestId,
        operation: "account_deletion_admin_backlog",
        category: "unexpected",
      });
    }
    return jsonError(apiError, requestId);
  }
}

function withoutStatus(
  result: AccountDeletionBacklog,
): Omit<AccountDeletionBacklog, "status"> {
  return {
    pending_jobs: result.pending_jobs,
    overdue_jobs: result.overdue_jobs,
    high_attempt_jobs: result.high_attempt_jobs,
    max_attempt_count: result.max_attempt_count,
    oldest_requested_at: result.oldest_requested_at,
    retrying_jobs: result.retrying_jobs,
    completed_receipts: result.completed_receipts,
  };
}
