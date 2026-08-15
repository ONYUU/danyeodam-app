import { describe, expect, it, vi } from 'vitest';

import type { CurrentPolicyManifest } from '@/api/policies';

import {
  assertTrustedPolicyManifest,
  verifyTrustedResource,
} from './verification';

const hash = 'a'.repeat(64);
const maxDocumentBytes = 2 * 1024 * 1024;

function manifest(url = 'https://policies.example/privacy'): CurrentPolicyManifest {
  return {
    supportUrl: 'https://support.example/help',
    policies: ['terms_of_use', 'privacy_policy', 'community_guidelines', 'location_terms']
      .map((type) => ({
        type: type as CurrentPolicyManifest['policies'][number]['type'],
        version: '2026-08-13',
        effectiveAt: '2026-08-13T00:00:00.000Z',
        documents: Object.fromEntries(
          ['ko', 'en', 'ja', 'zh-Hans', 'zh-Hant', 'vi'].map((locale) => [
            locale,
            { url, sha256: hash },
          ]),
        ) as CurrentPolicyManifest['policies'][number]['documents'],
      })),
  };
}

function response(overrides: Partial<Response> = {}): Response {
  const base = new Response('verified policy body', {
    status: 200,
    headers: { 'content-length': '20', 'content-type': 'text/html; charset=utf-8' },
  });
  Object.defineProperties(base, {
    redirected: { value: false },
    type: { value: 'basic' },
    url: { value: 'https://policies.example/privacy' },
  });
  for (const [key, value] of Object.entries(overrides)) {
    Object.defineProperty(base, key, { value });
  }
  return base;
}

function verify(overrides: Partial<Parameters<typeof verifyTrustedResource>[0]> = {}) {
  return verifyTrustedResource({
    acceptedContentTypes: ['text/html'],
    allowedOrigins: ['https://policies.example'],
    expectedSha256: hash,
    fetchResource: async () => response(),
    hashBytes: async () => hash,
    url: 'https://policies.example/privacy',
    ...overrides,
  });
}

describe('policy resource trust boundary', () => {
  it('accepts only exact allowlisted HTTPS origins for every manifest URL', () => {
    expect(() => assertTrustedPolicyManifest(manifest(), [
      'https://policies.example',
      'https://support.example',
    ])).not.toThrow();
    expect(() => assertTrustedPolicyManifest(
      manifest('https://policies.example.evil.test/privacy'),
      ['https://policies.example', 'https://support.example'],
    )).toThrow('POLICY_RESOURCE_VERIFICATION_FAILED');
    expect(() => assertTrustedPolicyManifest(
      manifest('http://policies.example/privacy'),
      ['https://policies.example', 'https://support.example'],
    )).toThrow();
  });

  it('returns the exact verified bytes from one credential-free, no-redirect request', async () => {
    const fetchResource = vi.fn(async () => response());
    const verified = await verify({ fetchResource });

    expect(new TextDecoder().decode(verified.bytes)).toBe('verified policy body');
    expect(verified).toMatchObject({
      contentType: 'text/html',
      integrity: 'sha256',
      url: 'https://policies.example/privacy',
    });
    expect(fetchResource).toHaveBeenCalledWith(
      'https://policies.example/privacy',
      expect.objectContaining({
        credentials: 'omit',
        method: 'GET',
        redirect: 'error',
      }),
    );
  });

  it('distinguishes hash-pinned policy bytes from HTTPS-origin-only support bytes', async () => {
    const support = await verifyTrustedResource({
      acceptedContentTypes: ['text/html'],
      allowedOrigins: ['https://policies.example'],
      fetchResource: async () => response(),
      url: 'https://policies.example/privacy',
    });
    expect(support.integrity).toBe('https-origin');

    const fetchResource = vi.fn(async () => response());
    await expect(verify({
      expectedSha256: 'A'.repeat(64),
      fetchResource,
    })).rejects.toThrow('POLICY_RESOURCE_VERIFICATION_FAILED');
    expect(fetchResource).not.toHaveBeenCalled();
  });

  it('rejects redirects, changed URLs, hash mismatches, and unexpected content types', async () => {
    await expect(verify({
      fetchResource: async () => response({ redirected: true }),
    })).rejects.toThrow();
    await expect(verify({
      fetchResource: async () => response({ url: 'https://policies.example/changed' }),
    })).rejects.toThrow();
    await expect(verify({
      hashBytes: async () => 'b'.repeat(64),
    })).rejects.toThrow();
    await expect(verify({
      fetchResource: async () => response({
        headers: new Headers({
          'content-length': '20',
          'content-type': 'application/pdf',
        }),
      }),
    })).rejects.toThrow();
  });

  it('accepts a bounded streamed body without Content-Length', async () => {
    await expect(verify({
      fetchResource: async () => response({
        headers: new Headers({ 'content-type': 'text/html' }),
      }),
    })).resolves.toMatchObject({ contentType: 'text/html' });
  });

  it('rejects declared oversized and lying Content-Length values', async () => {
    await expect(verify({
      fetchResource: async () => response({
        headers: new Headers({
          'content-length': String(maxDocumentBytes + 1),
          'content-type': 'text/html',
        }),
      }),
    })).rejects.toThrow();
    await expect(verify({
      fetchResource: async () => response({
        headers: new Headers({
          'content-length': '1',
          'content-type': 'text/html',
        }),
      }),
    })).rejects.toThrow();
  });

  it('cancels as soon as a no-length stream crosses the 2 MiB limit', async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(new Uint8Array(maxDocumentBytes));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled();
      },
    });

    await expect(verify({
      fetchResource: async () => response({
        body,
        headers: new Headers({ 'content-type': 'text/html' }),
      }),
    })).rejects.toThrow();
    expect(cancelled).toHaveBeenCalled();
  });

  it('fails within one fixed deadline when fetch or body reading never resolves', async () => {
    await expect(verify({
      deadlineMs: 20,
      fetchResource: async () => new Promise<Response>(() => undefined),
    })).rejects.toThrow('POLICY_RESOURCE_VERIFICATION_FAILED');

    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const body = {
      getReader: () => ({
        cancel,
        read: async () => new Promise<ReadableStreamReadResult<Uint8Array<ArrayBuffer>>>(
          () => undefined,
        ),
        releaseLock,
      }),
    } as unknown as ReadableStream<Uint8Array<ArrayBuffer>>;
    await expect(verify({
      deadlineMs: 20,
      fetchResource: async () => response({ body }),
    })).rejects.toThrow('POLICY_RESOURCE_VERIFICATION_FAILED');
    expect(cancel).toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalled();
  });
});
