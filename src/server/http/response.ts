import type { ApiError } from "@/server/http/api-error";

function responseHeaders(requestId: string, overrides?: HeadersInit): Headers {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Request-Id": requestId,
  });
  if (overrides !== undefined) {
    new Headers(overrides).forEach((value, key) => headers.set(key, value));
  }
  return headers;
}

export function jsonSuccess(
  body: Record<string, unknown>,
  status: number,
  requestId: string,
  headers?: HeadersInit,
): Response {
  return Response.json(body, {
    status,
    headers: responseHeaders(requestId, headers),
  });
}

export function emptySuccess(
  status: 204,
  requestId: string,
  overrides?: HeadersInit,
): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Request-Id": requestId,
  });
  if (overrides !== undefined) {
    new Headers(overrides).forEach((value, key) => headers.set(key, value));
  }
  return new Response(null, {
    status,
    headers,
  });
}

export function jsonError(
  error: ApiError,
  requestId: string,
  headers?: HeadersInit,
): Response {
  const payload: Record<string, unknown> = {
    code: error.code,
    message: error.message,
    request_id: requestId,
  };
  if (error.details !== undefined) {
    payload.details = error.details;
  }

  const errorHeaders = new Headers();
  const retryAfter = error.code === "RATE_LIMITED"
    ? error.details?.retry_after_seconds
    : undefined;
  if (
    typeof retryAfter === "number"
    && Number.isSafeInteger(retryAfter)
    && retryAfter > 0
  ) {
    errorHeaders.set("Retry-After", String(retryAfter));
  }
  if (headers !== undefined) {
    new Headers(headers).forEach((value, key) => errorHeaders.set(key, value));
  }

  return Response.json(
    { error: payload },
    {
      status: error.status,
      headers: responseHeaders(requestId, errorHeaders),
    },
  );
}
