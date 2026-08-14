import { readLimitedJson } from "@/server/http/body";
import { toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import { requirePublicShareAccess } from "@/server/public-shares/access";
import { publicShareResponseHeaders } from "@/server/public-shares/headers";
import {
  parsePublicShareReportInput,
  PUBLIC_SHARE_REPORT_MAXIMUM_BYTES,
} from "@/server/public-shares/input";
import { createPublicReportClientKey } from "@/server/reports/client-key";
import { submitContentReport } from "@/server/reports/service";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId();
  const securityHeaders = publicShareResponseHeaders();

  try {
    const { publicSharePublicationOpen } = requirePublicShareAccess(request);
    const input = parsePublicShareReportInput(
      await readLimitedJson(request, PUBLIC_SHARE_REPORT_MAXIMUM_BYTES),
    );
    const reporterKeyHash = createPublicReportClientKey(request.headers);
    const result = await submitContentReport({
      shareSlug: input.shareSecret,
      report: input.report,
      reporterKeyHash,
      publicSharePublicationOpen,
    });
    return jsonSuccess(
      { report: { id: result.id, status: "received" } },
      202,
      requestId,
      securityHeaders,
    );
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "public_content_report", category: "unexpected" });
    }
    const retryAfter = apiError.code === "RATE_LIMITED"
      ? apiError.details?.retry_after_seconds
      : undefined;
    return jsonError(
      apiError,
      requestId,
      publicShareResponseHeaders(
        typeof retryAfter === "number" ? { "Retry-After": String(retryAfter) } : undefined,
      ),
    );
  }
}
