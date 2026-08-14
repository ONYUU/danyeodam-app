import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();

vi.mock("@/server/supabase/service", () => ({
  getServiceClient: () => ({
    schema: () => ({ rpc }),
  }),
}));

vi.mock("@/server/env", () => ({
  getServerEnvironment: () => ({
    NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
  }),
}));

import { downloadPublishedCardAsset } from "@/server/cards/assets";

const cardId = "00000000-0000-4000-8000-000000000102";

describe("downloadPublishedCardAsset", () => {
  beforeEach(() => {
    rpc.mockResolvedValue({ data: "cards/seoul.webp", error: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes through the upstream stream without exposing its storage path", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const fetchMock = vi.fn(async () => new Response(source, {
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "Content-Length": "3",
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadPublishedCardAsset(cardId);

    expect(result.contentType).toBe("image/webp");
    expect(result.contentLength).toBe(3);
    expect(await new Response(result.body).arrayBuffer()).toEqual(
      new Uint8Array([1, 2, 3]).buffer,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://project.supabase.co/storage/v1/object/card-assets/cards/seoul.webp"),
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("maps a missing path or object to NOT_FOUND", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(downloadPublishedCardAsset(cardId)).rejects.toMatchObject({ code: "NOT_FOUND" });

    rpc.mockResolvedValueOnce({ data: "cards/missing.webp", error: null });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    await expect(downloadPublishedCardAsset(cardId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps an upstream outage distinct from a missing object", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    await expect(downloadPublishedCardAsset(cardId)).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("rejects unexpected MIME and oversized objects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1]), {
      status: 200,
      headers: { "Content-Type": "text/html", "Content-Length": "1" },
    })));
    await expect(downloadPublishedCardAsset(cardId)).rejects.toMatchObject({ code: "INTERNAL" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1]), {
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "Content-Length": String(10 * 1024 * 1024 + 1),
      },
    })));
    await expect(downloadPublishedCardAsset(cardId)).rejects.toMatchObject({ code: "INTERNAL" });
  });
});
