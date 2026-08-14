export type ReviewerPasswordAuthClient = {
  signInWithPassword(credentials: {
    email: string;
    password: string;
  }): Promise<{
    data: { session: { access_token?: string } | null };
    error: unknown | null;
  }>;
};

/**
 * Starts an existing-account password session for the dedicated Store-reviewer
 * path. The caller owns all user-facing error copy so Auth error details never
 * become an account-enumeration signal.
 */
export async function signInReviewerWithPassword(
  auth: ReviewerPasswordAuthClient,
  email: string,
  password: string,
): Promise<string | null> {
  const normalizedEmail = email.trim();
  if (normalizedEmail === "" || password === "") return null;

  try {
    const { data, error } = await auth.signInWithPassword({
      email: normalizedEmail,
      password,
    });
    if (error !== null) return null;

    const accessToken = data.session?.access_token;
    return typeof accessToken === "string" && accessToken !== ""
      ? accessToken
      : null;
  } catch {
    return null;
  }
}
