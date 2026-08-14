import type {
  CurrentPolicyManifest,
} from '@/api/policies';

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_DEADLINE_MS = 10_000;

export class PolicyResourceVerificationError extends Error {
  constructor() {
    super('POLICY_RESOURCE_VERIFICATION_FAILED');
    this.name = 'PolicyResourceVerificationError';
  }
}

function fail(): never {
  throw new PolicyResourceVerificationError();
}

function canonicalTrustedUrl(value: string, allowedOrigins: readonly string[]): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail();
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.hash !== ''
    || !allowedOrigins.includes(parsed.origin)
  ) {
    return fail();
  }
  return parsed.toString();
}

export function assertTrustedPolicyManifest(
  manifest: CurrentPolicyManifest,
  allowedOrigins: readonly string[],
): void {
  if (allowedOrigins.length === 0 || new Set(allowedOrigins).size !== allowedOrigins.length) {
    fail();
  }
  for (const policy of manifest.policies) {
    for (const document of Object.values(policy.documents)) {
      canonicalTrustedUrl(document.url, allowedOrigins);
    }
  }
  if (manifest.supportUrl !== null) {
    canonicalTrustedUrl(manifest.supportUrl, allowedOrigins);
  }
}

type FetchResponse = Pick<
  Response,
  'body' | 'headers' | 'redirected' | 'status' | 'type' | 'url'
>;

export type PolicyResourceFetch = (
  url: string,
  init: RequestInit,
) => Promise<FetchResponse>;

export type VerifiedTrustedResource = {
  bytes: ArrayBuffer;
  contentType: string;
  url: string;
};

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new PolicyResourceVerificationError());
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new PolicyResourceVerificationError());
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      () => {
        signal.removeEventListener('abort', aborted);
        reject(new PolicyResourceVerificationError());
      },
    );
  });
}

function copyChunks(chunks: readonly Uint8Array[], byteLength: number): ArrayBuffer {
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

export async function verifyTrustedResource(input: {
  acceptedContentTypes: readonly string[];
  allowedOrigins: readonly string[];
  deadlineMs?: number;
  expectedSha256?: string;
  fetchResource: PolicyResourceFetch;
  hashBytes(bytes: ArrayBuffer): Promise<string>;
  signal?: AbortSignal;
  url: string;
}): Promise<VerifiedTrustedResource> {
  const expectedUrl = canonicalTrustedUrl(input.url, input.allowedOrigins);
  const deadlineMs = input.deadlineMs ?? DEFAULT_DEADLINE_MS;
  if (
    !Number.isSafeInteger(deadlineMs)
    || deadlineMs < 1
    || deadlineMs > 30_000
    || input.acceptedContentTypes.length === 0
  ) {
    fail();
  }

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (input.signal?.aborted) {
    controller.abort();
  } else {
    input.signal?.addEventListener('abort', abortFromCaller, { once: true });
  }
  const deadline = setTimeout(() => controller.abort(), deadlineMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  try {
    const response = await abortable(input.fetchResource(expectedUrl, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      headers: { Accept: input.acceptedContentTypes.join(',') },
      signal: controller.signal,
    }), controller.signal);
    if (
      response.status < 200
      || response.status >= 300
      || response.redirected
      || response.type === 'opaque'
      || response.type === 'opaqueredirect'
      || response.url === ''
      || canonicalTrustedUrl(response.url, input.allowedOrigins) !== expectedUrl
    ) {
      fail();
    }

    const contentType = response.headers.get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase() ?? '';
    if (!input.acceptedContentTypes.includes(contentType)) {
      fail();
    }

    const declaredLengthValue = response.headers.get('content-length');
    let declaredLength: number | null = null;
    if (declaredLengthValue !== null) {
      if (!/^\d+$/u.test(declaredLengthValue)) {
        fail();
      }
      declaredLength = Number(declaredLengthValue);
      if (
        !Number.isSafeInteger(declaredLength)
        || declaredLength < 1
        || declaredLength > MAX_DOCUMENT_BYTES
      ) {
        fail();
      }
    }
    if (response.body === null) {
      fail();
    }

    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    while (true) {
      const part = await abortable(reader.read(), controller.signal);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) {
        fail();
      }
      if (part.value.byteLength > MAX_DOCUMENT_BYTES - byteLength) {
        void reader.cancel().catch(() => undefined);
        controller.abort();
        fail();
      }
      if (part.value.byteLength > 0) {
        chunks.push(part.value.slice());
        byteLength += part.value.byteLength;
      }
    }
    if (byteLength === 0) {
      fail();
    }
    if (
      declaredLength !== null
      && response.headers.get('content-encoding') === null
      && byteLength !== declaredLength
    ) {
      fail();
    }

    const bytes = copyChunks(chunks, byteLength);
    if (input.expectedSha256 !== undefined) {
      const actualSha256 = await abortable(input.hashBytes(bytes), controller.signal);
      if (actualSha256 !== input.expectedSha256) {
        fail();
      }
    }
    return { bytes, contentType, url: expectedUrl };
  } catch {
    controller.abort();
    if (reader !== null) {
      void reader.cancel().catch(() => undefined);
    }
    throw new PolicyResourceVerificationError();
  } finally {
    clearTimeout(deadline);
    input.signal?.removeEventListener('abort', abortFromCaller);
    try {
      reader?.releaseLock();
    } catch {
      // A timed-out native read can still be settling after abort. The owned
      // controller and cancel request already close the resource fail-safe.
    }
  }
}
