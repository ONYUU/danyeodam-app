import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAdultAccessToken } from "@/server/auth/verify-adult-access-token";
import { parseBlockId, parseBlockMutationInput } from "@/server/blocks/input";
import { unblockUser } from "@/server/blocks/service";
import { toApiError } from "@/server/http/api-error";
import { readLimitedJson } from "@/server/http/body";
import { createRequestId } from "@/server/http/request-id";
import { emptySuccess, jsonError } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";

export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = createRequestId();
  try {
    const authUserId = await verifyAdultAccessToken(requireBearerToken(request));
    const blockId = parseBlockId((await context.params).id);
    const input = parseBlockMutationInput(await readLimitedJson(request));
    await unblockUser({ authUserId, blockId, clientActionId: input.client_action_id });
    return emptySuccess(204, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "revoke_user_block", category: "unexpected" });
    }
    return jsonError(apiError, requestId);
  }
}
