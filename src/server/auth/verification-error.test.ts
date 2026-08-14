import {
  AuthApiError,
  AuthRetryableFetchError,
} from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { classifyAuthVerificationError } from "@/server/auth/verification-error";

describe("classifyAuthVerificationError", () => {
  it("treats rejected credentials as unauthorized", () => {
    expect(classifyAuthVerificationError(
      new AuthApiError("bad token", 401, "bad_jwt"),
    )).toBe("UNAUTHORIZED");
  });

  it("does not tell the client to delete a session during a retryable outage", () => {
    expect(classifyAuthVerificationError(
      new AuthRetryableFetchError("temporarily unavailable", 503),
    )).toBe("INTERNAL");
  });

  it("treats unknown and server failures as internal", () => {
    expect(classifyAuthVerificationError(new Error("network"))).toBe("INTERNAL");
    expect(classifyAuthVerificationError(
      new AuthApiError("service failure", 500, "unexpected_failure"),
    )).toBe("INTERNAL");
  });
});
