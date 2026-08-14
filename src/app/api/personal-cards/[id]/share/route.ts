import { z } from "zod";

import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyActiveIdentityAccessToken } from "@/server/auth/verify-active-identity-access-token";
import { verifyAdultAccessToken } from "@/server/auth/verify-adult-access-token";
import {
  getServerEnvironment,
  isPublicRecruitmentOpen,
  isPublicShareCreationOpen,
} from "@/server/env";
import { ApiError, toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { emptySuccess, jsonError, jsonSuccess } from "@/server/http/response";
import { logSafeServerError } from "@/server/logging/safe-log";
import {
  disablePersonalCardShare,
  enablePersonalCardShare,
  readPersonalCardShareStatus,
} from "@/server/shares/service";

export const runtime = "nodejs";

const personalCardIdSchema = z.uuid();

async function parsePersonalCardId(
  context: { params: Promise<{ id: string }> },
): Promise<string> {
  const result = personalCardIdSchema.safeParse((await context.params).id);
  if (!result.success) {
    throw new ApiError("NOT_FOUND");
  }
  return result.data;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = createRequestId();

  try {
    const authUserId = await verifyAdultAccessToken(requireBearerToken(request));
    const personalCardId = await parsePersonalCardId(context);
    const environment = getServerEnvironment();
    const result = await enablePersonalCardShare({
      authUserId,
      publicGateOpen: isPublicRecruitmentOpen(environment.PUBLIC_RECRUIT_GATE),
      publicShareCreationOpen: isPublicShareCreationOpen(environment.PUBLIC_SHARE_CREATION),
      personalCardId,
      publicAppUrl: environment.PUBLIC_APP_URL,
    });
    return jsonSuccess(result.body, result.status, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "personal_card_share", category: "unexpected" });
    }
    return jsonError(apiError, requestId);
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = createRequestId();

  try {
    const authUserId = await verifyAdultAccessToken(requireBearerToken(request));
    const personalCardId = await parsePersonalCardId(context);
    const result = await readPersonalCardShareStatus({
      authUserId,
      personalCardId,
      publicAppUrl: getServerEnvironment().PUBLIC_APP_URL,
    });
    return jsonSuccess({ share: result }, 200, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "personal_card_share_status", category: "unexpected" });
    }
    return jsonError(apiError, requestId);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = createRequestId();

  try {
    const authUserId = await verifyActiveIdentityAccessToken(requireBearerToken(request));
    const personalCardId = await parsePersonalCardId(context);
    await disablePersonalCardShare({
      authUserId,
      personalCardId,
    });
    return emptySuccess(204, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "personal_card_unshare", category: "unexpected" });
    }
    return jsonError(apiError, requestId);
  }
}
