import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyAdultAccessTokenUser,
  getEmailLinkEligibility,
  requestEmailLink,
  logSafeServerError,
} = vi.hoisted(() => ({
  verifyAdultAccessTokenUser: vi.fn(),
  getEmailLinkEligibility: vi.fn(),
  requestEmailLink: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/auth/verify-adult-access-token", () => ({ verifyAdultAccessTokenUser }));
vi.mock("@/server/access/repository", () => ({ getEmailLinkEligibility }));
vi.mock("@/server/auth/link-email", () => ({ requestEmailLink }));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));

import { POST } from "@/app/api/auth/link-email/route";

const validInput = {
  email: "person@example.com",
  flow_id: "11111111-1111-4111-8111-111111111111",
  code_challenge: "A".repeat(43),
  code_challenge_method: "s256",
};

function linkRequest(
  body: Record<string, unknown>,
  token = "test-access-token",
): Request {
  return new Request("https://api.example.test/api/auth/link-email", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/link-email", () => {
  beforeEach(() => {
    verifyAdultAccessTokenUser.mockReset();
    getEmailLinkEligibility.mockReset();
    requestEmailLink.mockReset();
    logSafeServerError.mockReset();
    getEmailLinkEligibility.mockResolvedValue({ status: "eligible" });
  });

  it("accepts only the anonymous S256 flow and returns the pending boundary", async () => {
    verifyAdultAccessTokenUser.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      isAnonymous: true,
    });
    requestEmailLink.mockResolvedValue(undefined);

    const response = await POST(linkRequest(validInput));

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(requestEmailLink).toHaveBeenCalledWith("test-access-token", validInput);
  });

  it.each([
    [{ ...validInput, code_challenge_method: "plain" }],
    [{ ...validInput, code_challenge: "A".repeat(42) }],
    [{ ...validInput, flow_id: "ABCDEFAB-CDEF-4ABC-8ABC-ABCDEFABCDEF" }],
    [{ ...validInput, code_verifier: "must-not-cross-the-boundary" }],
  ])("rejects a non-exact PKCE payload before calling Auth", async (body) => {
    verifyAdultAccessTokenUser.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      isAnonymous: true,
    });

    const response = await POST(linkRequest(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });
    expect(requestEmailLink).not.toHaveBeenCalled();
  });

  it("rejects a permanent user before reading or forwarding the linking payload", async () => {
    verifyAdultAccessTokenUser.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      isAnonymous: false,
    });

    const response = await POST(linkRequest(validInput));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    expect(requestEmailLink).not.toHaveBeenCalled();
  });

  it("rejects a reviewer from the fresh DB decision before forwarding the payload", async () => {
    verifyAdultAccessTokenUser.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      isAnonymous: true,
    });
    getEmailLinkEligibility.mockResolvedValue({ status: "reviewer_forbidden" });

    const response = await POST(linkRequest(validInput));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    expect(requestEmailLink).not.toHaveBeenCalled();
  });

  it("logs only the fixed operation category on an Auth outage", async () => {
    verifyAdultAccessTokenUser.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      isAnonymous: true,
    });
    requestEmailLink.mockRejectedValue(new Error("upstream unavailable"));

    const response = await POST(linkRequest(validInput, "private-token-value"));

    expect(response.status).toBe(500);
    expect(logSafeServerError).toHaveBeenCalledWith({
      requestId: expect.any(String),
      operation: "link_email",
      category: "unexpected",
    });
    const logged = JSON.stringify(logSafeServerError.mock.calls);
    expect(logged).not.toContain("person@example.com");
    expect(logged).not.toContain("private-token-value");
    expect(logged).not.toContain("A".repeat(43));
  });
});
