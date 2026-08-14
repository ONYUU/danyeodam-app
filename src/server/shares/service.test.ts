import { describe, expect, it, vi } from "vitest";

import {
  disablePersonalCardShare,
  enablePersonalCardShare,
  readPublicShare,
  readPublicSharePhoto,
  readPersonalCardShareStatus,
  type ShareServiceDependencies,
} from "@/server/shares/service";

const authUserId = "11111111-1111-4111-8111-111111111111";
const userId = "11111111-1111-4111-8111-222222222222";
const personalCardId = "22222222-2222-4222-8222-222222222222";
const photoPath = `${authUserId}/${personalCardId}.webp`;
const shareSlugs = [
  "AAAAAAAAAAAAAAAAAAAAAA",
  "BBBBBBBBBBBBBBBBBBBBBB",
  "CCCCCCCCCCCCCCCCCCCCCC",
] as const;

function foundShare() {
  return {
    status: "found" as const,
    personal_card_id: personalCardId,
    date_kst: "2026-08-09",
    spot: { name: {
      ko: "경복궁", en: "Gyeongbokgung", ja: "景福宮",
      "zh-Hans": "景福宫", "zh-Hant": "景福宮", vi: "Cung Gyeongbok",
    } },
    caption: "여행",
    photo_path: photoPath,
  };
}

function makeDependencies(
  overrides: Partial<ShareServiceDependencies> = {},
): ShareServiceDependencies {
  return {
    createSlug: vi.fn(() => shareSlugs[0]),
    createShare: vi.fn(async () => ({
      status: "pending" as const,
      share_slug: shareSlugs[0],
      share_state: "pending" as const,
    })),
    revokeShare: vi.fn(async () => ({ status: "revoked" as const })),
    findShareStatus: vi.fn(async () => ({
      status: "found" as const,
      share_state: "pending" as const,
      share_slug: shareSlugs[0],
      reason_code: null,
      submitted_at: "2026-08-09T00:00:00.000Z",
      reviewed_at: null,
    })),
    findPublicShare: vi.fn(async () => foundShare()),
    downloadPhoto: vi.fn(async () => ({
      body: new ReadableStream<Uint8Array>(),
      contentType: "image/webp" as const,
      contentLength: 10,
    })),
    ...overrides,
  };
}

describe("share service", () => {
  it("retries a candidate slug conflict up to three times", async () => {
    const createSlug = vi.fn()
      .mockReturnValueOnce(shareSlugs[0])
      .mockReturnValueOnce(shareSlugs[1])
      .mockReturnValueOnce(shareSlugs[2]);
    const createShare = vi.fn()
      .mockResolvedValueOnce({ status: "slug_conflict" as const, expected_user_id: userId })
      .mockResolvedValueOnce({ status: "slug_conflict" as const, expected_user_id: userId })
      .mockResolvedValueOnce({
        status: "pending" as const,
        share_slug: shareSlugs[2],
        share_state: "pending" as const,
      });
    const dependencies = makeDependencies({ createSlug, createShare });

    await expect(enablePersonalCardShare({
      authUserId,
      publicGateOpen: false,
      publicShareCreationOpen: true,
      personalCardId,
      publicAppUrl: "https://danyeodam.example",
    }, dependencies)).resolves.toEqual({
      status: 202,
      body: { share: {
        slug: shareSlugs[2],
        url: `https://danyeodam.example/share#${shareSlugs[2]}`,
        status: "pending",
      } },
    });
    expect(createShare).toHaveBeenCalledTimes(3);
    expect(createShare).toHaveBeenLastCalledWith({
      authUserId,
      publicGateOpen: false,
      publicShareCreationOpen: true,
      personalCardId,
      shareSlug: shareSlugs[2],
      expectedUserId: userId,
    });
  });

  it("fails closed without adding a public error code after three slug conflicts", async () => {
    const dependencies = makeDependencies({
      createShare: vi.fn(async () => ({
        status: "slug_conflict" as const,
        expected_user_id: userId,
      })),
    });

    await expect(enablePersonalCardShare({
      authUserId,
      publicGateOpen: false,
      publicShareCreationOpen: true,
      personalCardId,
      publicAppUrl: "https://danyeodam.example",
    }, dependencies)).rejects.toMatchObject({ code: "INTERNAL", status: 500 });
    expect(dependencies.createShare).toHaveBeenCalledTimes(3);
  });

  it("maps gate and ownership results to existing public errors", async () => {
    const gated = makeDependencies({
      createShare: vi.fn(async () => ({ status: "share_creation_gate_closed" as const })),
    });
    await expect(enablePersonalCardShare({
      authUserId,
      publicGateOpen: false,
      publicShareCreationOpen: false,
      personalCardId,
      publicAppUrl: undefined,
    }, gated)).rejects.toMatchObject({
      code: "GATE_CLOSED",
      status: 403,
      details: { gate: "share_creation" },
    });
    expect(gated.createSlug).not.toHaveBeenCalled();
    expect(gated.createShare).toHaveBeenCalledWith({
      authUserId,
      publicGateOpen: false,
      publicShareCreationOpen: false,
      personalCardId,
      shareSlug: null,
    });

    const missing = makeDependencies({
      revokeShare: vi.fn(async () => ({ status: "not_found" as const })),
    });
    await expect(disablePersonalCardShare({
      authUserId,
      personalCardId,
    }, missing)).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("maps missing policy acceptance and owner suspension before sharing", async () => {
    const policyRequired = makeDependencies({
      createShare: vi.fn(async () => ({
        status: "policy_required" as const,
        required: [{ type: "terms_of_use" as const, version: "1.0" }],
      })),
    });
    await expect(enablePersonalCardShare({
      authUserId,
      publicGateOpen: true,
      publicShareCreationOpen: true,
      personalCardId,
      publicAppUrl: "https://danyeodam.example",
    }, policyRequired)).rejects.toMatchObject({ code: "POLICY_ACCEPTANCE_REQUIRED", status: 428 });

    const suspended = makeDependencies({
      createShare: vi.fn(async () => ({ status: "account_suspended" as const })),
    });
    await expect(enablePersonalCardShare({
      authUserId,
      publicGateOpen: true,
      publicShareCreationOpen: true,
      personalCardId,
      publicAppUrl: "https://danyeodam.example",
    }, suspended)).rejects.toMatchObject({ code: "ACCOUNT_SUSPENDED", status: 403 });
  });

  it("returns moderation status only to the authenticated owner", async () => {
    const dependencies = makeDependencies();
    await expect(readPersonalCardShareStatus({
      authUserId,
      personalCardId,
      publicAppUrl: "https://danyeodam.example",
    }, dependencies)).resolves.toMatchObject({
      status: "pending",
      slug: shareSlugs[0],
      url: `https://danyeodam.example/share#${shareSlugs[0]}`,
    });
  });

  it("treats repeated revocation as an idempotent success", async () => {
    const dependencies = makeDependencies({
      revokeShare: vi.fn(async () => ({ status: "already_revoked" as const })),
    });

    await expect(disablePersonalCardShare({
      authUserId,
      personalCardId,
    }, dependencies)).resolves.toBeUndefined();
  });

  it("projects a public view without a storage path, exact time, coordinates, or sequence", async () => {
    const dependencies = makeDependencies();

    await expect(readPublicShare({
      shareSlug: shareSlugs[0],
      viewerAuthUserId: null,
      publicSharePublicationOpen: true,
    }, dependencies)).resolves.toEqual({
      date_kst: "2026-08-09",
      spot: foundShare().spot,
      caption: "여행",
      photo_available: true,
    });
    expect(dependencies.findPublicShare).toHaveBeenCalledWith({
      shareSlug: shareSlugs[0],
      viewerAuthUserId: null,
      recordView: true,
      publicSharePublicationOpen: true,
    });
  });

  it("rechecks the active slug without recording a second view before every photo download", async () => {
    const dependencies = makeDependencies();

    await readPublicSharePhoto({
      shareSlug: shareSlugs[0],
      viewerAuthUserId: authUserId,
      publicSharePublicationOpen: true,
    }, dependencies);

    expect(dependencies.findPublicShare).toHaveBeenCalledWith({
      shareSlug: shareSlugs[0],
      viewerAuthUserId: authUserId,
      recordView: false,
      publicSharePublicationOpen: true,
    });
    expect(dependencies.downloadPhoto).toHaveBeenCalledWith(photoPath);
  });

  it("does not touch Storage after a revoked slug is rejected", async () => {
    const dependencies = makeDependencies({
      findPublicShare: vi.fn(async () => ({ status: "not_found" as const })),
    });

    await expect(readPublicSharePhoto({
      shareSlug: shareSlugs[0],
      viewerAuthUserId: null,
      publicSharePublicationOpen: false,
    }, dependencies)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    expect(dependencies.downloadPhoto).not.toHaveBeenCalled();
    expect(dependencies.findPublicShare).toHaveBeenCalledWith({
      shareSlug: shareSlugs[0],
      viewerAuthUserId: null,
      recordView: false,
      publicSharePublicationOpen: false,
    });
  });
});
