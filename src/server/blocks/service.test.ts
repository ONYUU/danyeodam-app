import { describe, expect, it, vi } from "vitest";

import {
  blockShareOwner,
  readUserBlocks,
  unblockUser,
  type UserBlockServiceDependencies,
} from "@/server/blocks/service";

const authUserId = "11111111-1111-4111-8111-111111111111";
const blockId = "22222222-2222-4222-8222-222222222222";
const clientActionId = "33333333-3333-4333-8333-333333333333";
const cursorSecret = "test-only-block-cursor-secret-000001";

function dependencies(
  overrides: Partial<UserBlockServiceDependencies> = {},
): UserBlockServiceDependencies {
  return {
    create: vi.fn(async () => ({ status: "blocked" as const, duplicate: false })),
    list: vi.fn(async () => ({
      status: "ready" as const,
      items: [],
      has_more: false,
      next_anchor: null,
    })),
    revoke: vi.fn(async () => ({ status: "revoked" as const, duplicate: false })),
    ...overrides,
  };
}

describe("user block service", () => {
  it("treats block and unblock retries as empty idempotent success", async () => {
    const deps = dependencies({
      create: vi.fn(async () => ({ status: "blocked" as const, duplicate: true })),
      revoke: vi.fn(async () => ({ status: "revoked" as const, duplicate: true })),
    });
    await expect(blockShareOwner({
      authUserId,
      shareSlug: "AAAAAAAAAAAAAAAAAAAAAA",
      clientActionId,
      publicSharePublicationOpen: true,
    }, deps)).resolves.toBeUndefined();
    await expect(unblockUser({ authUserId, blockId, clientActionId }, deps)).resolves.toBeUndefined();
  });

  it("projects only opaque block ids and creation timestamps", async () => {
    const deps = dependencies({
      list: vi.fn(async () => ({
        status: "ready" as const,
        items: [{ id: blockId, created_at: "2026-08-12T00:00:00.000Z" }],
        has_more: true,
        next_anchor: { id: blockId, created_at: "2026-08-12T00:00:00.000Z" },
      })),
    });
    const first = await readUserBlocks({ authUserId, limit: 1, cursorSecret }, deps);
    expect(first.items).toEqual([
      { id: blockId, created_at: "2026-08-12T00:00:00.000Z" },
    ]);
    expect(first.page).toEqual({ has_more: true, next_cursor: expect.any(String) });
    const list = vi.fn(async () => ({
      status: "ready" as const,
      items: [],
      has_more: false,
      next_anchor: null,
    }));
    await readUserBlocks({
      authUserId,
      limit: 1,
      cursor: first.page.next_cursor ?? undefined,
      cursorSecret,
    }, dependencies({ list }));
    expect(list).toHaveBeenCalledWith({
      authUserId,
      limit: 1,
      beforeCreatedAt: "2026-08-12T00:00:00.000Z",
      beforeId: blockId,
    });
  });

  it("maps rate and idempotency results to bounded public errors", async () => {
    const rateLimited = dependencies({
      create: vi.fn(async () => ({ status: "rate_limited" as const, retry_after_seconds: 60 })),
    });
    await expect(blockShareOwner({
      authUserId,
      shareSlug: "AAAAAAAAAAAAAAAAAAAAAA",
      clientActionId,
      publicSharePublicationOpen: true,
    }, rateLimited)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
      details: { retry_after_seconds: 60 },
    });

    const publicationClosed = dependencies({
      create: vi.fn(async () => ({ status: "not_found" as const })),
    });
    await expect(blockShareOwner({
      authUserId,
      shareSlug: "AAAAAAAAAAAAAAAAAAAAAA",
      clientActionId,
      publicSharePublicationOpen: false,
    }, publicationClosed)).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

    const conflict = dependencies({
      revoke: vi.fn(async () => ({ status: "idempotency_conflict" as const })),
    });
    await expect(unblockUser({ authUserId, blockId, clientActionId }, conflict))
      .rejects.toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
        status: 409,
        message: "같은 요청 키가 이전 요청과 일치하지 않습니다.",
      });
  });
});
