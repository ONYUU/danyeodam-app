import { toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import { getServerEnvironment } from "@/server/env";
import { readCurrentPolicyManifest } from "@/server/policies/service";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const requestId = createRequestId();
  try {
    const environment = getServerEnvironment();
    const manifest = await readCurrentPolicyManifest({
      supportUrl: environment.PUBLIC_SUPPORT_URL,
    });
    return jsonSuccess(manifest, 200, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "current_policies", category: "unexpected" });
    }
    return jsonError(apiError, requestId);
  }
}
