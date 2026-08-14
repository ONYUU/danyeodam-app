import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getServerEnvironment,
  issuePersonalCardUpload,
  verifyAdultAccessToken,
} = vi.hoisted(() => ({
  getServerEnvironment: vi.fn(),
  issuePersonalCardUpload: vi.fn(),
  verifyAdultAccessToken: vi.fn(),
}));

vi.mock("@/server/auth/verify-adult-access-token", () => ({ verifyAdultAccessToken }));
vi.mock("@/server/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/env")>();
  return { ...actual, getServerEnvironment };
});
vi.mock("@/server/personal-cards/service", () => ({ issuePersonalCardUpload }));

import { POST } from "@/app/api/personal-cards/upload-url/route";
import { ApiError } from "@/server/http/api-error";

const authUserId = "11111111-1111-4111-8111-111111111111";
const clientRequestId = "22222222-2222-4222-8222-222222222222";

function request(): Request {
  return new Request("https://api.example.test/api/personal-cards/upload-url", {
    method: "POST",
    headers: {
      authorization: "Bearer adult-access-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      content_type: "image/jpeg",
      size: 123,
      client_request_id: clientRequestId,
    }),
  });
}

describe("POST /api/personal-cards/upload-url", () => {
  beforeEach(() => {
    getServerEnvironment.mockReset();
    issuePersonalCardUpload.mockReset();
    verifyAdultAccessToken.mockReset();
    getServerEnvironment.mockReturnValue({ PUBLIC_RECRUIT_GATE: "false" });
    verifyAdultAccessToken.mockResolvedValue(authUserId);
  });

  it("passes the strict logical request key to the upload service", async () => {
    issuePersonalCardUpload.mockResolvedValue({
      upload_url: "https://storage.example/signed-upload",
      temp_path: `${authUserId}/upload.jpg`,
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(issuePersonalCardUpload).toHaveBeenCalledWith({
      authUserId,
      publicGateOpen: false,
      upload: {
        content_type: "image/jpeg",
        size: 123,
        client_request_id: clientRequestId,
      },
    });
  });

  it("rejects a missing client_request_id before the database call", async () => {
    const invalid = new Request(
      "https://api.example.test/api/personal-cards/upload-url",
      {
        method: "POST",
        headers: {
          authorization: "Bearer adult-access-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ content_type: "image/jpeg", size: 123 }),
      },
    );

    const response = await POST(invalid);

    expect(response.status).toBe(400);
    expect(issuePersonalCardUpload).not.toHaveBeenCalled();
  });

  it("returns Retry-After for the rolling upload URL limit", async () => {
    issuePersonalCardUpload.mockRejectedValue(
      new ApiError("RATE_LIMITED", { retry_after_seconds: 37 }),
    );

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("37");
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "RATE_LIMITED",
        details: { retry_after_seconds: 37 },
      },
    });
  });

  it("returns the contracted 409 storage quota code without Retry-After", async () => {
    issuePersonalCardUpload.mockRejectedValue(
      new ApiError("QUOTA_EXCEEDED", { reason: "active_temp_uploads" }),
    );

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(response.headers.get("retry-after")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "QUOTA_EXCEEDED",
        details: { reason: "active_temp_uploads" },
      },
    });
  });

  it("returns 409 when one logical upload key is reused with another payload", async () => {
    issuePersonalCardUpload.mockRejectedValue(new ApiError("IDEMPOTENCY_CONFLICT"));

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });
  });
});
