import { describe, expect, it, vi } from "vitest";

import { readCollection } from "@/server/collection/service";

const authUserId = "11111111-1111-4111-8111-111111111111";
const cursorSecret = "test-only-collection-cursor-secret-0001";
const localized = {
  ko: "서울", en: "Seoul", ja: "ソウル",
  "zh-Hans": "首尔", "zh-Hant": "首爾", vi: "Seoul",
};

function item(index: number, type: "field" | "retro" | "gift" = "field") {
  const suffix = String(index).padStart(12, "0");
  return {
    acquisition: {
      id: `00000000-0000-4000-8000-${suffix}`,
      spot_id: "22222222-2222-4222-8222-222222222222",
      card_id: "33333333-3333-4333-8333-333333333333",
      type,
      acquired_at: `2026-08-${String(12 - index).padStart(2, "0")}T00:00:00.000Z`,
      date_kst: `2026-08-${String(12 - index).padStart(2, "0")}`,
    },
    spot: { slug: "seoul", name: localized },
    card: { title: localized, sketch_path: "hidden/card.webp", color_hex: "#123456" },
    personal_card: null,
  };
}

describe("collection service", () => {
  it("returns a user-bound cursor from the database anchor and strips private fields", async () => {
    const read = vi.fn(async () => ({
      status: "ready" as const,
      items: [item(1), item(2)],
      has_more: true,
      next_anchor: {
        acquired_at: item(2).acquisition.acquired_at,
        id: item(2).acquisition.id,
      },
      stats: { total_acquisitions: 3, spots_visited: 1, personal_cards: 0 },
    }));
    const first = await readCollection({
      authUserId,
      limit: 2,
      cursorSecret,
      publicAppUrl: "https://danyeodam.example",
    }, { read });

    expect(read).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }));
    expect(first.page.has_more).toBe(true);
    expect(first.page.next_cursor).toEqual(expect.any(String));
    expect(JSON.stringify(first)).not.toContain("sketch_path");
    expect(JSON.stringify(first)).not.toContain("photo_path");

    await readCollection({
      authUserId,
      limit: 2,
      cursor: first.page.next_cursor ?? undefined,
      cursorSecret,
      publicAppUrl: "https://danyeodam.example",
    }, { read });
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({
      beforeAcquiredAt: item(2).acquisition.acquired_at,
      beforeAcquisitionId: item(2).acquisition.id,
    }));
  });

  it("maps an inactive identity to 401", async () => {
    await expect(readCollection({
      authUserId,
      limit: 50,
      cursorSecret,
      publicAppUrl: "https://danyeodam.example",
    }, { read: vi.fn(async () => ({ status: "unauthorized" as const })) }))
      .rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
  });

  it("projects owned photos and exposes a public URL only for an active share", async () => {
    const personalCardId = "44444444-4444-4444-8444-444444444444";
    const shareSlug = "AbCdEfGhIjKlMnOpQrStUv";
    const result = await readCollection({
      authUserId,
      limit: 1,
      cursorSecret,
      publicAppUrl: "https://danyeodam.example",
    }, { read: vi.fn(async () => ({
      status: "ready" as const,
      items: [{
        ...item(1),
        personal_card: {
          id: personalCardId,
          caption: "기억",
          photo_path: `${authUserId}/${personalCardId}.webp`,
          created_at: "2026-08-12T00:00:00.000Z",
          share_status: "active" as const,
          share_slug: shareSlug,
          reason_code: null,
        },
      }],
      has_more: false,
      next_anchor: null,
      stats: { total_acquisitions: 1, spots_visited: 1, personal_cards: 1 },
    })) });

    expect(result.items[0]?.personal_card).toMatchObject({
      photo_url: `/api/personal-cards/${personalCardId}/photo`,
      share: {
        status: "active",
        slug: shareSlug,
        url: `https://danyeodam.example/share#${shareSlug}`,
      },
    });
    expect(JSON.stringify(result)).not.toContain("photo_path");
  });
});
