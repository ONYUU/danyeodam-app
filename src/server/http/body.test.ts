import { describe, expect, it } from "vitest";

import { readLimitedJson } from "@/server/http/body";

describe("readLimitedJson", () => {
  it("parses a bounded JSON body", async () => {
    const request = new Request("https://example.test/api", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: true }),
    });
    await expect(readLimitedJson(request)).resolves.toEqual({ ok: true });
  });

  it("rejects non-JSON content", async () => {
    const request = new Request("https://example.test/api", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    await expect(readLimitedJson(request)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("rejects an oversized streamed body even without content-length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"value":"${"x".repeat(100)}"}`));
        controller.close();
      },
    });
    const request = new Request("https://example.test/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readLimitedJson(request, 32)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("rejects malformed JSON without echoing the body", async () => {
    const request = new Request("https://example.test/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json}",
    });
    await expect(readLimitedJson(request)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "요청 형식이 올바르지 않습니다.",
    });
  });
});
