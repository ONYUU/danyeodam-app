import { afterEach, describe, expect, it, vi } from "vitest";

import {
  discardPublicShareResponseBody,
  postPublicShareJson,
  PUBLIC_SHARE_REQUEST_TIMEOUT_MS,
} from "@/app/share/request";
import {
  consumePublicSharePhotoResponse,
  consumePublicShareReportResponse,
  consumePublicShareResolveResponse,
} from "@/app/share/response";

function signalCapturingFetch(response = new Response(null, { status: 204 })) {
  let requestSignal: AbortSignal | undefined;
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestSignal = init?.signal instanceof AbortSignal ? init.signal : undefined;
    return response;
  });
  return { fetchMock, requestSignal: () => requestSignal };
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function signalBoundStalledFetch(status: number, contentType: string) {
  let requestSignal: AbortSignal | undefined;
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      bodyController = controller;
    },
  }), { status, headers: { "content-type": contentType } });
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestSignal = init?.signal instanceof AbortSignal ? init.signal : undefined;
    requestSignal?.addEventListener("abort", () => {
      bodyController?.error(requestSignal?.reason);
    }, { once: true });
    return response;
  });
  return { fetchMock, requestSignal: () => requestSignal };
}

function cancellableStalledResponse(status: number, contentType: string) {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
    status,
    headers: { "content-type": contentType },
  });
  return { cancel, response };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("public share request boundary", () => {
  it("keeps the 15-second deadline active while the response body is consumed", async () => {
    vi.useFakeTimers();
    const pending = signalCapturingFetch();
    vi.stubGlobal("fetch", pending.fetchMock);

    const request = postPublicShareJson(
      "/api/public-share/resolve",
      "{}",
      (_response, requestSignal) => waitForAbort(requestSignal),
    );
    const rejected = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(PUBLIC_SHARE_REQUEST_TIMEOUT_MS);

    await rejected;
    expect(pending.requestSignal()?.aborted).toBe(true);
  });

  it("times out a headers-only 202 report whose JSON body stalls", async () => {
    vi.useFakeTimers();
    const pending = signalBoundStalledFetch(202, "application/json");
    vi.stubGlobal("fetch", pending.fetchMock);

    const request = postPublicShareJson(
      "/api/public-share/report",
      "{}",
      consumePublicShareReportResponse,
    );
    const rejected = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(PUBLIC_SHARE_REQUEST_TIMEOUT_MS);

    await rejected;
    expect(pending.requestSignal()?.aborted).toBe(true);
  });

  it("strictly validates a complete 202 report receipt within the request deadline", async () => {
    const valid = signalCapturingFetch(Response.json({
      report: {
        id: "11111111-1111-4111-8111-111111111111",
        status: "received",
      },
    }, { status: 202 }));
    vi.stubGlobal("fetch", valid.fetchMock);
    await expect(postPublicShareJson(
      "/api/public-share/report",
      "{}",
      consumePublicShareReportResponse,
    )).resolves.toBe(true);

    const extra = signalCapturingFetch(Response.json({
      report: {
        id: "11111111-1111-4111-8111-111111111111",
        status: "received",
        owner_id: "22222222-2222-4222-8222-222222222222",
      },
    }, { status: 202 }));
    vi.stubGlobal("fetch", extra.fetchMock);
    await expect(postPublicShareJson(
      "/api/public-share/report",
      "{}",
      consumePublicShareReportResponse,
    )).resolves.toBe(false);
  });

  it("cancels stalled 428, error, and unused photo bodies before returning", async () => {
    vi.useFakeTimers();
    const age = cancellableStalledResponse(428, "application/json");
    const error = cancellableStalledResponse(500, "application/json");
    const photo = cancellableStalledResponse(200, "text/plain");

    vi.stubGlobal("fetch", signalCapturingFetch(age.response).fetchMock);
    await expect(postPublicShareJson(
      "/api/public-share/resolve",
      "{}",
      consumePublicShareResolveResponse,
    )).resolves.toEqual({ kind: "age" });
    vi.stubGlobal("fetch", signalCapturingFetch(error.response).fetchMock);
    await expect(postPublicShareJson(
      "/api/public-share/report",
      "{}",
      consumePublicShareReportResponse,
    )).resolves.toBe(false);
    vi.stubGlobal("fetch", signalCapturingFetch(photo.response).fetchMock);
    await expect(postPublicShareJson(
      "/api/public-share/photo",
      "{}",
      consumePublicSharePhotoResponse,
    )).resolves.toBeNull();
    expect(age.cancel).toHaveBeenCalledOnce();
    expect(error.cancel).toHaveBeenCalledOnce();
    expect(photo.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a body through the shared discard helper", async () => {
    const stalled = cancellableStalledResponse(500, "application/json");
    await discardPublicShareResponseBody(stalled.response);
    expect(stalled.cancel).toHaveBeenCalledOnce();
  });

  it("aborts an in-flight request when the share shell unmounts", async () => {
    vi.useFakeTimers();
    const pending = signalCapturingFetch();
    vi.stubGlobal("fetch", pending.fetchMock);
    const lifecycleController = new AbortController();

    const request = postPublicShareJson(
      "/api/public-share/report",
      "{}",
      (_response, requestSignal) => waitForAbort(requestSignal),
      lifecycleController.signal,
    );
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
    lifecycleController.abort();

    await rejected;
    expect(pending.requestSignal()?.aborted).toBe(true);
  });
});
