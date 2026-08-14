import { beforeEach, describe, expect, it, vi } from "vitest";

const upload = vi.fn();
const from = vi.fn(() => ({ upload }));

vi.mock("@/server/supabase/service", () => ({
  getServiceClient: () => ({ storage: { from } }),
}));

import { uploadPersonalCardPermanentObject } from "@/server/personal-cards/storage";

describe("personal-card permanent storage", () => {
  beforeEach(() => {
    upload.mockReset();
    from.mockClear();
    upload.mockResolvedValue({ error: null });
  });

  it("never overwrites an object already owned by the processing token", async () => {
    const path =
      "11111111-1111-4111-8111-111111111111/55555555-5555-4555-8555-555555555555.webp";
    const bytes = Uint8Array.from([1, 2, 3]);

    await expect(uploadPersonalCardPermanentObject(path, bytes)).resolves.toBeUndefined();

    expect(from).toHaveBeenCalledWith("personal-cards");
    expect(upload).toHaveBeenCalledWith(path, bytes, {
      cacheControl: "31536000",
      contentType: "image/webp",
      upsert: false,
    });
  });
});
