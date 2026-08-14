import { z } from "zod";

import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyActiveIdentityAccessToken } from "@/server/auth/verify-active-identity-access-token";
import { ApiError, toApiError } from "@/server/http/api-error";
import { readLimitedJson } from "@/server/http/body";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import { parsePersonalCardDeletionInput } from "@/server/personal-cards/input";
import { deletePersonalCard } from "@/server/personal-cards/service";

export const runtime = "nodejs";
export const maxDuration = 60;

const personalCardIdSchema = z.uuid();

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = createRequestId();
  try {
    const authUserId = await verifyActiveIdentityAccessToken(requireBearerToken(request));
    const parsedId = personalCardIdSchema.safeParse((await context.params).id);
    if (!parsedId.success) throw new ApiError("NOT_FOUND");
    const deletion = parsePersonalCardDeletionInput(await readLimitedJson(request));
    const result = await deletePersonalCard({
      authUserId,
      personalCardId: parsedId.data,
      clientRequestId: deletion.client_request_id,
    });
    return jsonSuccess(result, 202, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({
        requestId,
        operation: "personal_card_delete",
        category: "unexpected",
      });
    }
    return jsonError(apiError, requestId);
  }
}
