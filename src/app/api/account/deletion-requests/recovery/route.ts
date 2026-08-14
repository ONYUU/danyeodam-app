import { parseRecoveryDeletionRequestInput } from "@/server/account-deletion/input";
import {
  consumeAccountDeletionPublicRateLimit,
  requestAccountDeletionByRecovery,
} from "@/server/account-deletion/repository";
import {
  hashAccountDeletionSecret,
  publicRateLimitSubjectDigest,
  trustedClientIp,
} from "@/server/account-deletion/secret";
import { getServerEnvironment } from "@/server/env";
import { ApiError, toApiError } from "@/server/http/api-error";
import { readLimitedJson } from "@/server/http/body";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import { hashRecoveryCode } from "@/server/recovery/code";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId();

  try {
    const environment = getServerEnvironment();
    const ipRate = await consumeAccountDeletionPublicRateLimit({
      scope: "account_deletion_recovery_ip",
      subjectHashHex: publicRateLimitSubjectDigest({
        ip: trustedClientIp(request),
        scope: "account_deletion_recovery_ip",
        secret: environment.ACCOUNT_DELETION_RATE_LIMIT_SECRET,
      }),
    });
    if (ipRate.status === "rate_limited") {
      throw new ApiError("RATE_LIMITED", {
        retry_after_seconds: ipRate.retry_after_seconds,
      });
    }

    const input = parseRecoveryDeletionRequestInput(await readLimitedJson(request));
    const result = await requestAccountDeletionByRecovery({
      recoveryCodeHashHex: hashRecoveryCode(input.recovery_code),
      requestId: input.client_request_id,
      statusTokenHashHex: hashAccountDeletionSecret(input.status_token),
    });

    if (result.status === "accepted") {
      return jsonSuccess({ deletion_request: result.deletion_request }, 202, requestId);
    }
    if (result.status === "rate_limited") {
      throw new ApiError("RATE_LIMITED", {
        retry_after_seconds: result.retry_after_seconds,
      });
    }
    if (
      result.status === "idempotency_conflict"
      || result.status === "already_requested"
    ) {
      throw new ApiError("IDEMPOTENCY_CONFLICT");
    }
    throw new ApiError("NOT_FOUND");
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({
        requestId,
        operation: "account_deletion_recovery_request",
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
