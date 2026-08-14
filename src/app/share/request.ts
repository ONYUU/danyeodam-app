export const PUBLIC_SHARE_REQUEST_TIMEOUT_MS = 15_000;

export async function discardPublicShareResponseBody(response: Response): Promise<void> {
  if (response.body !== null) {
    await response.body.cancel();
  }
}

export async function postPublicShareJson<T>(
  path: string,
  body: string,
  consume: (response: Response, requestSignal: AbortSignal) => Promise<T> | T,
  lifecycleSignal?: AbortSignal,
): Promise<T> {
  const requestController = new AbortController();
  const abortForLifecycle = () => requestController.abort(lifecycleSignal?.reason);
  if (lifecycleSignal?.aborted === true) {
    abortForLifecycle();
  } else {
    lifecycleSignal?.addEventListener("abort", abortForLifecycle, { once: true });
  }
  const timeoutId = globalThis.setTimeout(() => {
    requestController.abort(new DOMException("Request timed out", "TimeoutError"));
  }, PUBLIC_SHARE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      cache: "no-store",
      credentials: "same-origin",
      referrerPolicy: "no-referrer",
      signal: requestController.signal,
    });
    return await consume(response, requestController.signal);
  } finally {
    globalThis.clearTimeout(timeoutId);
    lifecycleSignal?.removeEventListener("abort", abortForLifecycle);
  }
}
