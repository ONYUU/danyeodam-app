import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/env", () => ({
  getServerEnvironment: () => ({
    NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
    AUTH_EMAIL_REDIRECT_TO: "https://app.example/auth/callback",
  }),
}));

import { requestEmailLink } from "@/server/auth/link-email";

const linkInput = {
  email: "person@example.com",
  flow_id: "11111111-1111-4111-8111-111111111111",
  code_challenge: "A".repeat(43),
  code_challenge_method: "s256" as const,
};

describe("requestEmailLink", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("updates the current identity through the authenticated Auth endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestEmailLink("user-jwt", linkInput)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://project.supabase.co/auth/v1/user?redirect_to=https%3A%2F%2Fapp.example%2Fauth%2Fcallback%3Fsb_flow_id%3D11111111-1111-4111-8111-111111111111"),
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({ Authorization: "Bearer user-jwt" }),
        body: JSON.stringify({
          email: "person@example.com",
          code_challenge: "A".repeat(43),
          code_challenge_method: "s256",
        }),
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );

    const [, requestInit] = fetchMock.mock.calls[0] ?? [];
    const forwardedBody = JSON.parse(String(requestInit?.body));
    expect(forwardedBody).not.toHaveProperty("flow_id");
    expect(forwardedBody).not.toHaveProperty("code_verifier");
  });

  it.each([
    "email_exists",
    "email_conflict_identity_not_deletable",
    "user_already_exists",
    "conflict",
  ])("maps Auth conflict code %s to EMAIL_ALREADY_IN_USE", async (code) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code }, { status: 422 })));

    await expect(requestEmailLink("user-jwt", linkInput))
      .rejects.toMatchObject({ code: "EMAIL_ALREADY_IN_USE", status: 409 });
  });

  it("keeps authentication, throttling, and outages distinct", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    await expect(requestEmailLink("user-jwt", linkInput))
      .rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 429 })));
    await expect(requestEmailLink("user-jwt", linkInput))
      .rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    await expect(requestEmailLink("user-jwt", linkInput))
      .rejects.toMatchObject({ code: "INTERNAL", status: 500 });
  });
});
