import { describe, expect, it } from "vitest";

import {
  parseAccountDeletionAdminListQuery,
  parseAccountDeletionAdminRequestId,
  parseAccountDeletionAdminRetryInput,
} from "@/server/account-deletion/admin-input";

describe("account deletion admin input", () => {
  it("applies a bounded active-list default", () => {
    expect(parseAccountDeletionAdminListQuery(new URL("https://api.example.test")))
      .toEqual({ status: "active", limit: 50 });
    expect(parseAccountDeletionAdminListQuery(
      new URL("https://api.example.test?status=completed&limit=100"),
    )).toEqual({ status: "completed", limit: 100 });
  });

  it.each([
    "?limit=0",
    "?limit=101",
    "?limit=1.5",
    "?limit=01",
    "?status=unknown",
    "?status=active&user_id=secret",
    "?limit=10&limit=20",
    "?status=active&status=all",
  ])("rejects non-contract list query %s", (query) => {
    expect(() => parseAccountDeletionAdminListQuery(
      new URL(`https://api.example.test${query}`),
    )).toThrow();
  });

  it("requires the exact retry body", () => {
    const input = {
      action: "retry" as const,
      client_action_id: "22222222-2222-4222-8222-222222222222",
      reason_code: "WORKER_STALLED" as const,
      note: "  Worker lease was reviewed.  ",
    };
    expect(parseAccountDeletionAdminRetryInput(input)).toEqual({
      ...input,
      note: "Worker lease was reviewed.",
    });
    expect(() => parseAccountDeletionAdminRetryInput({})).toThrow();
    expect(() => parseAccountDeletionAdminRetryInput({
      ...input,
      user_id: "secret",
    })).toThrow();
    expect(() => parseAccountDeletionAdminRetryInput({
      ...input,
      reason_code: "FREE_TEXT_REASON",
    })).toThrow();
    expect(() => parseAccountDeletionAdminRetryInput({
      ...input,
      note: " ",
    })).toThrow();
  });

  it("treats malformed opaque request IDs as not found", () => {
    expect(parseAccountDeletionAdminRequestId(
      "11111111-1111-4111-8111-111111111111",
    )).toBe("11111111-1111-4111-8111-111111111111");
    expect(() => parseAccountDeletionAdminRequestId("not-a-uuid")).toThrow();
  });
});
