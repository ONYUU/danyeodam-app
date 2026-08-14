import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/env", () => ({
  getServerEnvironment: () => ({
    NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
  }),
}));

import { downloadSharePhoto } from "@/server/shares/storage";

const userId = "11111111-1111-4111-8111-111111111111";
const photoId = "22222222-2222-4222-8222-222222222222";
const photoPath = `${userId}/${photoId}.webp`;

describe("downloadSharePhoto", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams a bounded private WebP object", async () => {
    const timeoutSignal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSignal);
    const fetchMock = vi.fn(async () => new Response(Uint8Array.from([1, 2, 3]), {
      status: 200,
      headers: { "Content-Type": "image/webp", "Content-Length": "3" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadSharePhoto(photoPath);

    expect(result.contentType).toBe("image/webp");
    expect(result.contentLength).toBe(3);
    expect(await new Response(result.body).arrayBuffer()).toEqual(Uint8Array.from([1, 2, 3]).buffer);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(`https://project.supabase.co/storage/v1/object/personal-cards/${photoPath}`),
      expect.objectContaining({ cache: "no-store", signal: timeoutSignal }),
    );
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it("keeps a missing object distinct from a Storage outage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    await expect(downloadSharePhoto(photoPath)).rejects.toMatchObject({ code: "NOT_FOUND" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    await expect(downloadSharePhoto(photoPath)).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("rejects path redirection, unexpected MIME, and invalid declared size", async () => {
    await expect(downloadSharePhoto(`../${photoId}.webp`)).rejects.toMatchObject({
      code: "INTERNAL",
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(Uint8Array.from([1]), {
      status: 200,
      headers: { "Content-Type": "image/png", "Content-Length": "1" },
    })));
    await expect(downloadSharePhoto(photoPath)).rejects.toMatchObject({ code: "INTERNAL" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(Uint8Array.from([1]), {
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "Content-Length": String(10 * 1024 * 1024 + 1),
      },
    })));
    await expect(downloadSharePhoto(photoPath)).rejects.toMatchObject({ code: "INTERNAL" });
  });
});
