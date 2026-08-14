import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();

vi.mock("@/server/supabase/service", () => ({
  getServiceClient: () => ({
    schema: () => ({ rpc }),
  }),
}));

import {
  getAccessProjection,
  getEmailLinkEligibility,
} from "@/server/access/repository";

describe("getAccessProjection", () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it("returns the strict store-reviewer projection", async () => {
    rpc.mockResolvedValue({
      data: {
        status: "ready",
        participant: true,
        access_type: "store_reviewer",
        field_acquisition_requires_location: true,
        fixture_version: "store-2026.08.1",
      },
      error: null,
    });

    await expect(getAccessProjection("11111111-1111-4111-8111-111111111111"))
      .resolves.toEqual({
        status: "ready",
        participant: true,
        access_type: "store_reviewer",
        field_acquisition_requires_location: true,
        fixture_version: "store-2026.08.1",
      });
    expect(rpc).toHaveBeenCalledWith("get_access_projection", {
      p_auth_user_id: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("accepts standard and unauthorized projections", async () => {
    rpc.mockResolvedValueOnce({
      data: {
        status: "ready",
        participant: false,
        access_type: "standard",
        field_acquisition_requires_location: true,
        fixture_version: null,
      },
      error: null,
    });
    await expect(getAccessProjection("11111111-1111-4111-8111-111111111111"))
      .resolves.toMatchObject({ status: "ready", access_type: "standard" });

    rpc.mockResolvedValueOnce({ data: { status: "unauthorized" }, error: null });
    await expect(getAccessProjection("11111111-1111-4111-8111-111111111111"))
      .resolves.toEqual({ status: "unauthorized" });
  });

  it("fails closed on database and response-contract errors", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "unavailable" } });
    await expect(getAccessProjection("11111111-1111-4111-8111-111111111111"))
      .rejects.toThrow("Access projection lookup failed");

    rpc.mockResolvedValueOnce({
      data: {
        status: "ready",
        participant: true,
        access_type: "store_reviewer",
        field_acquisition_requires_location: false,
        fixture_version: "store-2026.08.1",
      },
      error: null,
    });
    await expect(getAccessProjection("11111111-1111-4111-8111-111111111111"))
      .rejects.toThrow("Access projection lookup failed");
  });
});

describe("getEmailLinkEligibility", () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it("returns the explicit reviewer denial from the active binding lookup", async () => {
    rpc.mockResolvedValue({
      data: { status: "reviewer_forbidden" },
      error: null,
    });

    await expect(getEmailLinkEligibility(
      "11111111-1111-4111-8111-111111111111",
    )).resolves.toEqual({ status: "reviewer_forbidden" });
    expect(rpc).toHaveBeenCalledWith("get_email_link_eligibility", {
      p_auth_user_id: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("fails closed on an invalid eligibility projection", async () => {
    rpc.mockResolvedValue({ data: { status: "unknown" }, error: null });

    await expect(getEmailLinkEligibility(
      "11111111-1111-4111-8111-111111111111",
    )).rejects.toThrow("Access projection lookup failed");
  });
});
