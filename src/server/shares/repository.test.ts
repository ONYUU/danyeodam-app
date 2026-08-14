import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();

vi.mock("@/server/supabase/service", () => ({
  getServiceClient: () => ({
    schema: () => ({ rpc }),
  }),
}));

import {
  createPersonalCardShare,
  getPublicShare,
  revokePersonalCardShare,
} from "@/server/shares/repository";

const authUserId = "11111111-1111-4111-8111-111111111111";
const personalCardId = "22222222-2222-4222-8222-222222222222";
const shareSlug = "AbCdEfGhIjKlMnOpQrStUv";

describe("share repository", () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it("passes the authenticated owner, gate, card, and candidate slug to the create RPC", async () => {
    rpc.mockResolvedValue({
      data: {
        status: "pending",
        share_slug: shareSlug,
        share_state: "pending",
      },
      error: null,
    });

    await expect(createPersonalCardShare({
      authUserId,
      publicGateOpen: false,
      publicShareCreationOpen: false,
      personalCardId,
      shareSlug,
    })).resolves.toEqual({
      status: "pending",
      share_slug: shareSlug,
      share_state: "pending",
    });
    expect(rpc).toHaveBeenCalledWith("create_personal_card_share", {
      p_auth_user_id: authUserId,
      p_public_gate_open: false,
      p_public_share_creation_open: false,
      p_personal_card_id: personalCardId,
      p_share_slug: shareSlug,
    });
  });

  it("uses separate revoke and public-read RPC contracts", async () => {
    rpc
      .mockResolvedValueOnce({ data: { status: "already_revoked" }, error: null })
      .mockResolvedValueOnce({
        data: {
          status: "found",
          personal_card_id: personalCardId,
          date_kst: "2026-08-09",
          spot: { name: {
            ko: "경복궁", en: "Gyeongbokgung", ja: "景福宮",
            "zh-Hans": "景福宫", "zh-Hant": "景福宮", vi: "Cung Gyeongbok",
          } },
          caption: "여행",
          photo_path: `${authUserId}/${personalCardId}.webp`,
        },
        error: null,
      });

    await revokePersonalCardShare({ authUserId, personalCardId });
    await getPublicShare({
      shareSlug,
      viewerAuthUserId: null,
      recordView: false,
      publicSharePublicationOpen: false,
    });

    expect(rpc).toHaveBeenNthCalledWith(1, "revoke_personal_card_share", {
      p_auth_user_id: authUserId,
      p_personal_card_id: personalCardId,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "get_public_share", {
      p_share_slug: shareSlug,
      p_viewer_auth_user_id: null,
      p_record_view: false,
      p_public_share_publication_open: false,
    });
  });
});
