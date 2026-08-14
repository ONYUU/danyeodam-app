import { describe, expect, it, vi } from "vitest";

import {
  signInReviewerWithPassword,
  type ReviewerPasswordAuthClient,
} from "@/app/account/delete/reviewer-auth";

function createAuthClient(
  result: Awaited<ReturnType<ReviewerPasswordAuthClient["signInWithPassword"]>>,
) {
  const signInWithPassword = vi.fn().mockResolvedValue(result);
  return {
    auth: { signInWithPassword } satisfies ReviewerPasswordAuthClient,
    signInWithPassword,
  };
}

describe("Store-reviewer password authentication for account deletion", () => {
  it("signs in the existing account with a trimmed email and returns only the access token", async () => {
    const { auth, signInWithPassword } = createAuthClient({
      data: { session: { access_token: "reviewer-access-token" } },
      error: null,
    });

    await expect(signInReviewerWithPassword(
      auth,
      "  reviewer@example.test ",
      " password-with-intentional-spaces ",
    )).resolves.toBe("reviewer-access-token");
    expect(signInWithPassword).toHaveBeenCalledOnce();
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "reviewer@example.test",
      password: " password-with-intentional-spaces ",
    });
  });

  it("returns the same closed result for an Auth error or a missing session", async () => {
    const authError = createAuthClient({
      data: { session: null },
      error: new Error("credential details must not reach the UI"),
    });
    const missingSession = createAuthClient({
      data: { session: null },
      error: null,
    });

    await expect(signInReviewerWithPassword(
      authError.auth,
      "reviewer@example.test",
      "wrong-password",
    )).resolves.toBeNull();
    await expect(signInReviewerWithPassword(
      missingSession.auth,
      "reviewer@example.test",
      "password",
    )).resolves.toBeNull();
  });

  it("turns a transport failure into the same closed result", async () => {
    const signInWithPassword = vi.fn().mockRejectedValue(new Error("network detail"));
    const auth = { signInWithPassword } satisfies ReviewerPasswordAuthClient;

    await expect(signInReviewerWithPassword(
      auth,
      "reviewer@example.test",
      "password",
    )).resolves.toBeNull();
  });

  it("does not call Auth when either credential is empty", async () => {
    const { auth, signInWithPassword } = createAuthClient({
      data: { session: null },
      error: null,
    });

    await expect(signInReviewerWithPassword(auth, " ", "password")).resolves.toBeNull();
    await expect(signInReviewerWithPassword(auth, "reviewer@example.test", "")).resolves.toBeNull();
    expect(signInWithPassword).not.toHaveBeenCalled();
  });
});
