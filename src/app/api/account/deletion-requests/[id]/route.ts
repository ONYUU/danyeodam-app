import {
  parseDeletionRequestId,
  parseDeletionStatusToken,
} from "@/server/account-deletion/input";
import {
  consumeAccountDeletionPublicRateLimit,
  getAccountDeletionStatusCandidate,
} from "@/server/account-deletion/repository";
import {
  constantTimeDigestMatch,
  hashAccountDeletionSecret,
  publicRateLimitSubjectDigest,
  trustedClientIp,
} from "@/server/account-deletion/secret";
import { getServerEnvironment } from "@/server/env";
import { ApiError, toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = createRequestId();

  try {
    const environment = getServerEnvironment();
    const ipRate = await consumeAccountDeletionPublicRateLimit({
      scope: "account_deletion_status_ip",
      subjectHashHex: publicRateLimitSubjectDigest({
        ip: trustedClientIp(request),
        scope: "account_deletion_status_ip",
        secret: environment.ACCOUNT_DELETION_RATE_LIMIT_SECRET,
      }),
    });
    if (ipRate.status === "rate_limited") {
      throw new ApiError("RATE_LIMITED", {
        retry_after_seconds: ipRate.retry_after_seconds,
      });
    }

    const deletionRequestId = parseDeletionRequestId((await context.params).id);
    const statusToken = parseDeletionStatusToken(
      request.headers.get("x-deletion-status-token"),
    );
    const candidate = await getAccountDeletionStatusCandidate(deletionRequestId);
    const suppliedHash = hashAccountDeletionSecret(statusToken);
    const expectedHash = candidate.status === "found"
      ? candidate.status_token_hash
      : "0".repeat(64);
    const tokenMatches = constantTimeDigestMatch(expectedHash, suppliedHash);
    if (
      candidate.status !== "found"
      || !tokenMatches
    ) {
      throw new ApiError("NOT_FOUND");
    }

    const isCompleted = candidate.public_status === "completed";
    const isOverdue = !isCompleted
      && candidate.reason_code === "overdue";

    return jsonSuccess({
      id: candidate.id,
      status: isCompleted
        ? "completed"
        : isOverdue
          ? "action_required"
          : "pending",
      reason_code: isOverdue
        ? "manual_support_required"
        : candidate.reason_code === "retrying"
          ? "retrying"
          : null,
      requested_at: candidate.requested_at,
      complete_by: candidate.complete_by,
      completed_at: candidate.completed_at,
      support_url: environment.ACCOUNT_DELETION_SUPPORT_URL ?? null,
    }, 200, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({
        requestId,
        operation: "account_deletion_status",
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
