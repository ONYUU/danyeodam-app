import { describe, expect, it } from "vitest";

import { ApiError } from "@/server/http/api-error";
import { jsonError, jsonSuccess } from "@/server/http/response";

describe("HTTP JSON responses", () => {
  it("keeps safe defaults while allowing an endpoint-specific cache policy", () => {
    const response = jsonSuccess(
      { ok: true },
      200,
      "11111111-1111-4111-8111-111111111111",
      { "Cache-Control": "private, no-store" },
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("x-request-id"))
      .toBe("11111111-1111-4111-8111-111111111111");
  });

  it("adds Retry-After globally for validated canonical rate-limit details", () => {
    const response = jsonError(
      new ApiError("RATE_LIMITED", { retry_after_seconds: 17 }),
      "11111111-1111-4111-8111-111111111111",
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
  });

  it("preserves an explicit endpoint header override", () => {
    const response = jsonError(
      new ApiError("RATE_LIMITED", { retry_after_seconds: 17 }),
      "11111111-1111-4111-8111-111111111111",
      { "Retry-After": "23" },
    );

    expect(response.headers.get("retry-after")).toBe("23");
  });

  it("does not emit an invalid or unrelated Retry-After value", () => {
    const invalid = jsonError(
      new ApiError("RATE_LIMITED", { retry_after_seconds: 1.5 }),
      "11111111-1111-4111-8111-111111111111",
    );
    const unrelated = jsonError(
      new ApiError("INTERNAL", { retry_after_seconds: 17 }),
      "11111111-1111-4111-8111-111111111111",
    );

    expect(invalid.headers.has("retry-after")).toBe(false);
    expect(unrelated.headers.has("retry-after")).toBe(false);
  });
});
