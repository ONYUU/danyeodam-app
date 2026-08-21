import { beforeEach, describe, expect, it, vi } from "vitest";

const { readPublicReleaseState, logSafeServerError } = vi.hoisted(() => ({
  readPublicReleaseState: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/release-state", () => ({ readPublicReleaseState }));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));

import { GET } from "@/app/api/release-state/route";

const releaseState = {
  schemaVersion: 1 as const,
  vercelEnvironment: "production" as const,
  vercelTargetEnvironment: "production" as const,
  deploymentId: `dpl_${"A".repeat(28)}`,
  projectId: `prj_${"B".repeat(28)}`,
  sourceCommitSha: "a".repeat(40),
  publicRecruitGate: true,
  bonusPackIssuanceScope: "public" as const,
  publicShareCreation: true,
  publicSharePublication: true,
};

describe("GET /api/release-state", () => {
  beforeEach(() => {
    readPublicReleaseState.mockReset().mockReturnValue(releaseState);
    logSafeServerError.mockReset();
  });

  it("returns the exact non-secret deployment and rollout projection without caching", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toEqual(releaseState);
  });

  it("fails closed without disclosing a malformed or non-production environment", async () => {
    readPublicReleaseState.mockImplementation(() => {
      throw new Error("private runtime detail");
    });

    const response = await GET();

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(logSafeServerError).toHaveBeenCalledWith({
      requestId: expect.any(String),
      operation: "public_release_state",
      category: "configuration",
    });
    expect(JSON.stringify(logSafeServerError.mock.calls)).not.toContain(
      "private runtime detail",
    );
  });
});
