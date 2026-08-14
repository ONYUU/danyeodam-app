import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyActiveIdentityAccessToken } from "@/server/auth/verify-active-identity-access-token";
import { getServerEnvironment } from "@/server/env";
import { ApiError, toApiError } from "@/server/http/api-error";
import { readLimitedJson } from "@/server/http/body";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import { parseLocationCorrectionInput } from "@/server/location/input";
import {
  decodeLocationCorrectionCursor,
  encodeLocationCorrectionCursor,
} from "@/server/location/cursor";
import {
  readOwnLocationCorrections,
  submitLocationCorrection,
} from "@/server/location/service";
import { logSafeServerError } from "@/server/logging/safe-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId();
  try {
    const authUserId = await verifyActiveIdentityAccessToken(requireBearerToken(request));
    const url = new URL(request.url);
    const limitText = url.searchParams.get("limit");
    const limit = limitText === null ? 50 : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ApiError("VALIDATION_FAILED");
    }
    const secret = getServerEnvironment().LOCATION_COMPLIANCE_CURSOR_SECRET;
    if (!secret) throw new ApiError("INTERNAL");
    const cursorText = url.searchParams.get("cursor");
    const cursor = cursorText === null
      ? null
      : decodeLocationCorrectionCursor(cursorText, authUserId, secret);
    const items = await readOwnLocationCorrections({
      authUserId,
      limit,
      beforeRequestedAt: cursor?.requested_at ?? null,
      beforeId: cursor?.correction_request_id ?? null,
    });
    const last = items.at(-1);
    const nextCursor = items.length === limit && last
      ? encodeLocationCorrectionCursor(
          {
            requested_at: last.requested_at,
            correction_request_id: last.id,
          },
          authUserId,
          secret,
        )
      : null;
    return jsonSuccess({ items, next_cursor: nextCursor }, 200, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "location_corrections", category: "unexpected" });
    }
    return jsonError(apiError, requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId();
  try {
    const authUserId = await verifyActiveIdentityAccessToken(requireBearerToken(request));
    const correction = parseLocationCorrectionInput(await readLimitedJson(request));
    const result = await submitLocationCorrection({ authUserId, correction });
    return jsonSuccess(
      { correction_request_id: result.correction_request_id },
      result.created ? 201 : 200,
      requestId,
    );
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({ requestId, operation: "location_correction_create", category: "unexpected" });
    }
    return jsonError(apiError, requestId);
  }
}
