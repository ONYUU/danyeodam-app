import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();

vi.mock("@/server/supabase/service", () => ({
  getServiceClient: () => ({
    schema: () => ({ rpc }),
  }),
}));

import { claimRecoveryCode, issueRecoveryCode } from "@/server/recovery/repository";

describe("recovery repository", () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it("accepts the reviewer issue denial as a closed result", async () => {
    rpc.mockResolvedValue({
      data: { status: "reviewer_forbidden" },
      error: null,
    });

    await expect(issueRecoveryCode({
      authUserId: "11111111-1111-4111-8111-111111111111",
      codeHashHex: "a".repeat(64),
    })).resolves.toEqual({ status: "reviewer_forbidden" });
  });

  it("keeps a blocked reviewer claim non-enumerating", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: "P0002", message: "recovery code not found" },
    });

    await expect(claimRecoveryCode({
      authUserId: "11111111-1111-4111-8111-111111111111",
      codeHashHex: "b".repeat(64),
    })).resolves.toEqual({ status: "not_found" });
  });
});
