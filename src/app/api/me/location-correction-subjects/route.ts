import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyActiveIdentityAccessToken } from "@/server/auth/verify-active-identity-access-token";
import { getServerEnvironment } from "@/server/env";
import { ApiError, toApiError } from "@/server/http/api-error";
import { createRequestId } from "@/server/http/request-id";
import { jsonError, jsonSuccess } from "@/server/http/response";
import {
  decodeLocationCorrectionSubjectCursor,
  encodeLocationCorrectionSubjectCursor,
} from "@/server/location/cursor";
import { readLocationCorrectionSubjects } from "@/server/location/service";
import { logSafeServerError } from "@/server/logging/safe-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId();
  try {
    const authUserId = await verifyActiveIdentityAccessToken(
      requireBearerToken(request),
    );
    const url = new URL(request.url);
    const limitText = url.searchParams.get("limit");
    const limit = limitText === null ? 50 : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ApiError("VALIDATION_FAILED");
    }

    const secret = getServerEnvironment().LOCATION_COMPLIANCE_CURSOR_SECRET;
    if (!secret) throw new ApiError("INTERNAL");
    const cursorText = url.searchParams.get("cursor");
    const cursor = cursorText
      ? decodeLocationCorrectionSubjectCursor(cursorText, authUserId, secret)
      : null;
    const internalItems = await readLocationCorrectionSubjects({
      authUserId,
      limit,
      beforeAcquiredOnKst: cursor?.acquired_on_kst ?? null,
      beforeId: cursor?.acquisition_id ?? null,
    });
    const last = internalItems.at(-1);
    const nextCursor = internalItems.length === limit && last
      ? encodeLocationCorrectionSubjectCursor(
          {
            acquired_on_kst: last.acquired_on_kst,
            acquisition_id: last.field_acquisition_id,
          },
          authUserId,
          secret,
        )
      : null;
    const items = internalItems.map((item) => ({
      field_acquisition_id: item.field_acquisition_id,
      spot_id: item.spot_id,
      acquired_on_kst: item.acquired_on_kst,
    }));
    return jsonSuccess({ items, next_cursor: nextCursor }, 200, requestId);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === "INTERNAL") {
      logSafeServerError({
        requestId,
        operation: "location_correction_subjects",
        category: "unexpected",
      });
    }
    return jsonError(apiError, requestId);
  }
}
