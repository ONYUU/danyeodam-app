import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();

vi.mock("@/server/supabase/service", () => ({
  getServiceClient: () => ({
    schema: () => ({ rpc }),
  }),
}));

import { requireActiveIdentity } from "@/server/auth/active-identity";

describe("requireActiveIdentity", () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it("accepts an active logical-user binding", async () => {
    rpc.mockResolvedValue({ data: { status: "active" }, error: null });

    await expect(requireActiveIdentity("11111111-1111-4111-8111-111111111111"))
      .resolves.toBeUndefined();
  });

  it("maps a revoked or missing binding to UNAUTHORIZED", async () => {
    rpc.mockResolvedValue({ data: { status: "inactive" }, error: null });

    await expect(requireActiveIdentity("11111111-1111-4111-8111-111111111111"))
      .rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
  });

  it("fails closed on database and response-contract errors", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "unavailable" } });
    await expect(requireActiveIdentity("11111111-1111-4111-8111-111111111111"))
      .rejects.toMatchObject({ code: "INTERNAL", status: 500 });

    rpc.mockResolvedValueOnce({ data: { status: "unexpected" }, error: null });
    await expect(requireActiveIdentity("11111111-1111-4111-8111-111111111111"))
      .rejects.toMatchObject({ code: "INTERNAL", status: 500 });
  });
});
