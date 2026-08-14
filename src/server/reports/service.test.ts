import { describe, expect, it, vi } from "vitest";

import { submitContentReport } from "@/server/reports/service";

const input = {
  shareSlug: "AbCdEfGhIjKlMnOpQrStUv",
  reporterKeyHash: "a".repeat(64),
  publicSharePublicationOpen: true,
  report: {
    client_report_id: "11111111-1111-4111-8111-111111111111",
    target: "content" as const,
    reason: "privacy" as const,
  },
};

describe("content report service", () => {
  it("returns the same opaque report id for idempotent receipt", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    await expect(submitContentReport(input, {
      create: vi.fn(async () => ({ status: "received" as const, report_id: id, duplicate: true })),
    })).resolves.toEqual({ id });
  });

  it("preserves retry seconds for a 429 response header", async () => {
    await expect(submitContentReport(input, {
      create: vi.fn(async () => ({ status: "rate_limited" as const, retry_after_seconds: 120 })),
    })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
      details: { retry_after_seconds: 120 },
    });
  });

  it("passes the publication decision into the privileged repository boundary", async () => {
    const create = vi.fn(async () => ({ status: "not_found" as const }));
    await expect(submitContentReport({
      ...input,
      publicSharePublicationOpen: false,
    }, { create })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(create).toHaveBeenCalledWith({
      ...input,
      publicSharePublicationOpen: false,
    });
  });
});
