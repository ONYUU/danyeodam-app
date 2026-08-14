import { getServerEnvironment } from "@/server/env";
import { ApiError, toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { processLocationComplianceMaintenance } from "@/server/location/erasure";
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
    const result = await processLocationComplianceMaintenance();
    if (
      result.erasure.failed_items > 0
      || result.object_reconciliation.failed_items > 0
      || result.backlog.overdue_jobs > 0
      || result.backlog.high_attempt_jobs > 0
      || result.backlog.overdue_open_corrections > 0
      || result.backlog.overdue_object_reconciliations > 0
      || result.backlog.high_attempt_object_reconciliations > 0
    ) {
      logSafeServerError({
        requestId,
        operation: "location_compliance_maintenance_alert",
        category: "database",
        locationComplianceCounts: {
          failed_items: result.erasure.failed_items,
          object_failed_items: result.object_reconciliation.failed_items,
          pending_jobs: result.backlog.pending_jobs,
          overdue_jobs: result.backlog.overdue_jobs,
          high_attempt_jobs: result.backlog.high_attempt_jobs,
          max_attempt_count: result.backlog.max_attempt_count,
          open_corrections: result.backlog.open_corrections,
          overdue_open_corrections: result.backlog.overdue_open_corrections,
          pending_object_reconciliations:
            result.backlog.pending_object_reconciliations,
          overdue_object_reconciliations:
            result.backlog.overdue_object_reconciliations,
          high_attempt_object_reconciliations:
            result.backlog.high_attempt_object_reconciliations,
        },
      });
      throw new ApiError("INTERNAL");
    }
    return jsonSuccess(result, 200, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "location_compliance_maintenance", category: "unexpected" });
    }
    return jsonError(apiError, requestId);
  }
}
