import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getServerEnvironment,
  logSafeServerError,
  readCurrentPolicyManifest,
} = vi.hoisted(() => ({
  getServerEnvironment: vi.fn(),
  logSafeServerError: vi.fn(),
  readCurrentPolicyManifest: vi.fn(),
}));

vi.mock("@/server/env", () => ({ getServerEnvironment }));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));
vi.mock("@/server/policies/service", () => ({ readCurrentPolicyManifest }));

import { GET } from "@/app/api/policies/current/route";

describe("GET /api/policies/current", () => {
  beforeEach(() => {
    getServerEnvironment.mockReset();
    readCurrentPolicyManifest.mockReset();
    logSafeServerError.mockReset();
    getServerEnvironment.mockReturnValue({
      PUBLIC_SUPPORT_URL: "https://support.example/help",
    });
  });

  it("returns public support with the exact current policy manifest", async () => {
    const manifest = {
      support_url: "https://support.example/help",
      policies: [{ type: "privacy_policy", version: "2026-08-13" }],
    };
    readCurrentPolicyManifest.mockResolvedValue(manifest);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(manifest);
    expect(readCurrentPolicyManifest).toHaveBeenCalledWith({
      supportUrl: "https://support.example/help",
    });
  });

  it("fails closed without exposing configuration or policy details", async () => {
    readCurrentPolicyManifest.mockRejectedValue(new Error("private policy row"));

    const response = await GET();

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({
      error: { code: "INTERNAL" },
    });
    expect(logSafeServerError).toHaveBeenCalledWith({
      requestId: expect.any(String),
      operation: "current_policies",
      category: "unexpected",
    });
    expect(JSON.stringify(body)).not.toContain("private policy row");
  });
});
