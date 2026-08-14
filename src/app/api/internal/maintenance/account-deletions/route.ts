import { processAccountDeletionJobs } from "@/server/account-deletion/service";
import { getServerEnvironment } from "@/server/env";
import { ApiError, toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import { hasValidCronAuthorization } from "@/server/personal-cards/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId();

  try {
    const environment = getServerEnvironment();
    if (!hasValidCronAuthorization(
      request.headers.get("authorization"),
      environment.CRON_SECRET,
    )) {
      throw new ApiError("UNAUTHORIZED");
    }

    const result = await processAccountDeletionJobs();
    if (
      result.retrying > 0
      || result.failed_external_operations > 0
      || result.backlog.overdue_jobs > 0
      || result.backlog.high_attempt_jobs > 0
      || result.backlog.retrying_jobs > 0
    ) {
      logSafeServerError({
        requestId,
        operation: "account_deletion_maintenance_alert",
        category: "database",
        accountDeletionCounts: {
          retrying: result.retrying,
          failed_external_operations: result.failed_external_operations,
          pending_jobs: result.backlog.pending_jobs,
          overdue_jobs: result.backlog.overdue_jobs,
          high_attempt_jobs: result.backlog.high_attempt_jobs,
          max_attempt_count: result.backlog.max_attempt_count,
          retrying_jobs: result.backlog.retrying_jobs,
        },
      });
      throw new ApiError("INTERNAL");
    }
    return jsonSuccess(result, 200, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({
        requestId,
        operation: "account_deletion_maintenance",
        category: "unexpected",
      });
    }
    return jsonError(apiError, requestId);
  }
}
