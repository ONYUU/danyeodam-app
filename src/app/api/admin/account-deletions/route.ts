import { parseAccountDeletionAdminListQuery } from "@/server/account-deletion/admin-input";
import { listAccountDeletionJobsAdmin } from "@/server/account-deletion/repository";
import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAccessToken } from "@/server/auth/verify-access-token";
import { toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId();
  try {
    const adminAuthUserId = await verifyAccessToken(requireBearerToken(request));
    const query = parseAccountDeletionAdminListQuery(new URL(request.url));
    const items = await listAccountDeletionJobsAdmin({
      adminAuthUserId,
      ...query,
    });
    return jsonSuccess({ items }, 200, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({
        requestId,
        operation: "account_deletion_admin_list",
        category: "unexpected",
      });
    }
    return jsonError(apiError, requestId);
  }
}
