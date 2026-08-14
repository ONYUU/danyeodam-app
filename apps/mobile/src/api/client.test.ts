import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import {
  ApiResponseError,
  ApiTransportError,
  createApiClient,
  type ApiClientDependencies,
} from './client';

function dependencies(overrides: Partial<ApiClientDependencies> = {}) {
  return {
    apiBaseUrl: 'https://api.danyeodam.invalid',
    getAccessToken: vi.fn(async () => 'access-token' as string | null),
    clearLocalSession: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('createApiClient', () => {
  it('uses Expo fetch as the only production transport', async () => {
    const source = await readFile(new URL('./client.ts', import.meta.url), 'utf8');

    expect(source).toContain("import { fetch as expoFetch } from 'expo/fetch';");
    expect(source).toContain('dependencies.fetch ?? (expoFetch as typeof fetch)');
    expect(source).not.toMatch(/dependencies\.fetch\s*\?\?\s*(?:globalThis\.)?fetch[;\s]/u);
  });

  it('pins native redirect-error enforcement in the installed Expo transport', async () => {
    const [iosResponse, androidRequest, androidResponse] = await Promise.all([
      readFile(new URL('../../node_modules/expo/ios/Fetch/NativeResponse.swift', import.meta.url), 'utf8'),
      readFile(new URL('../../node_modules/expo/android/src/main/java/expo/modules/fetch/NativeRequest.kt', import.meta.url), 'utf8'),
      readFile(new URL('../../node_modules/expo/android/src/main/java/expo/modules/fetch/NativeResponse.kt', import.meta.url), 'utf8'),
    ]);

    expect(iosResponse).toContain('completionHandler(shouldFollowRedirects ? request : nil)');
    expect(iosResponse).toContain('if self.redirectMode == .error');
    expect(androidRequest).toContain('requestInit.redirect != NativeRequestRedirect.FOLLOW');
    expect(androidRequest).toContain('followRedirects(false)');
    expect(androidResponse).toContain('redirectMode == NativeRequestRedirect.ERROR');
  });

  it('adds the bearer token and locale without exposing them in the result', async () => {
    const requestFetch = vi.fn(async () => Response.json({ spots: [] }, {
      headers: { 'X-Request-Id': '11111111-1111-4111-8111-111111111111' },
    }));
    const deps = dependencies({
      apiBaseUrl: 'https://api.danyeodam.invalid',
      getAccessToken: async () => 'secret-access-token',
      clearLocalSession: async () => undefined,
      fetch: requestFetch,
    });
    const client = createApiClient(deps);

    await expect(client<{ spots: unknown[] }>('/api/spots', {
      locale: 'ja',
    })).resolves.toEqual({ spots: [] });
    expect(requestFetch).toHaveBeenCalledWith(
      new URL('https://api.danyeodam.invalid/api/spots'),
      expect.objectContaining({
        credentials: 'omit',
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'Accept-Language': 'ja',
          Authorization: 'Bearer secret-access-token',
        },
      }),
    );
  });

  it('fails every API redirect closed before credentials or bodies can be forwarded', async () => {
    const requestFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      throw new TypeError('redirect mode is error');
    });
    const client = createApiClient(dependencies({ fetch: requestFetch }));

    await expect(client('/api/public-share/block', {
      method: 'POST',
      json: { share_secret: 'A'.repeat(22) },
    })).rejects.toMatchObject({ failure: 'NETWORK_ERROR' });
    expect(requestFetch).toHaveBeenCalledOnce();
  });

  it('does not read or clear a session for a public request', async () => {
    const requestFetch = vi.fn(async (..._arguments: Parameters<typeof fetch>) => (
      Response.json({ ok: true })
    ));
    const deps = dependencies({
      apiBaseUrl: 'https://api.danyeodam.invalid',
      getAccessToken: async () => 'unused',
      clearLocalSession: async () => undefined,
      fetch: requestFetch,
    });
    const client = createApiClient(deps);

    await expect(client('/api/spots', { authenticated: false })).resolves.toEqual({ ok: true });
    const headers = requestFetch.mock.calls[0]?.[1]?.headers;
    expect(headers).not.toHaveProperty('Authorization');
  });

  it('sends a deletion status credential only to the exact public status route', async () => {
    const requestFetch = vi.fn(async () => Response.json({ status: 'pending' }));
    const client = createApiClient(dependencies({ fetch: requestFetch }));
    const token = 'A'.repeat(43);

    await expect(client(
      '/api/account/deletion-requests/11111111-1111-4111-8111-111111111111',
      { authenticated: false, deletionStatusToken: token },
    )).resolves.toEqual({ status: 'pending' });
    expect(requestFetch).toHaveBeenCalledWith(
      new URL('https://api.danyeodam.invalid/api/account/deletion-requests/11111111-1111-4111-8111-111111111111'),
      expect.objectContaining({
        headers: {
          Accept: 'application/json',
          'X-Deletion-Status-Token': token,
        },
      }),
    );

    for (const [path, options] of [
      ['/api/spots', { authenticated: false, deletionStatusToken: token }],
      ['/api/account/deletion-requests/11111111-1111-4111-8111-111111111111', {
        authenticated: true,
        deletionStatusToken: token,
      }],
      ['/api/account/deletion-requests/11111111-1111-4111-8111-111111111111', {
        authenticated: false,
        deletionStatusToken: 'not-a-token',
      }],
      ['/api/account/deletion-requests/111111111111-4111-8111-111111111111', {
        authenticated: false,
        deletionStatusToken: token,
      }],
    ] as const) {
      await expect(client(path, options)).rejects.toMatchObject({
        failure: 'INVALID_RESPONSE',
      });
    }
    expect(requestFetch).toHaveBeenCalledTimes(1);
  });

  it('supports conditional GETs without reading a 304 response body', async () => {
    const response = new Response(null, {
      status: 304,
      headers: { ETag: '"content-version"' },
    });
    const json = vi.spyOn(response, 'json');
    const requestFetch = vi.fn(async () => response);
    const client = createApiClient(dependencies({ fetch: requestFetch }));

    await expect(client.cacheAware('/api/spots', {
      authenticated: false,
      ifNoneMatch: '"content-version"',
      locale: 'ko',
    })).resolves.toEqual({
      status: 'not_modified',
      etag: '"content-version"',
    });
    expect(json).not.toHaveBeenCalled();
    expect(requestFetch).toHaveBeenCalledWith(
      new URL('https://api.danyeodam.invalid/api/spots'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'If-None-Match': '"content-version"',
        }),
      }),
    );
  });

  it('returns validated ETag metadata with a fresh conditional response', async () => {
    const client = createApiClient(dependencies({
      fetch: async () => Response.json({ spots: [] }, {
        headers: { ETag: '"next-version"' },
      }),
    }));

    await expect(client.cacheAware<{ spots: unknown[] }>('/api/spots', {
      authenticated: false,
    })).resolves.toEqual({
      status: 'fresh',
      data: { spots: [] },
      etag: '"next-version"',
    });
  });

  it('rejects an unsafe conditional request tag before fetching', async () => {
    const requestFetch = vi.fn();
    const client = createApiClient(dependencies({ fetch: requestFetch as typeof fetch }));

    await expect(client.cacheAware('/api/spots', {
      authenticated: false,
      ifNoneMatch: '"safe"\r\nx-secret: value',
    })).rejects.toMatchObject({ failure: 'INVALID_RESPONSE' });
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it('removes the local session before surfacing a protected 401', async () => {
    const clearLocalSession = vi.fn(async () => undefined);
    const requestFetch = vi.fn(async () => Response.json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'do not retain this server message',
        request_id: '40140140-1401-4401-8401-401401401401',
      },
    }, { status: 401 }));
    const client = createApiClient({
      apiBaseUrl: 'https://api.danyeodam.invalid',
      getAccessToken: async () => 'secret-access-token',
      clearLocalSession,
      fetch: requestFetch,
    });

    const error = await client('/api/me/collection').catch((reason: unknown) => reason);
    expect(clearLocalSession).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(ApiResponseError);
    expect(error).toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
      requestId: '40140140-1401-4401-8401-401401401401',
    });
    expect(String(error)).not.toContain('secret-access-token');
    expect(String(error)).not.toContain('server message');
  });

  it('clears a protected session before reading a 401 response body', async () => {
    let cleared = false;
    const response = new Response(null, { status: 401 });
    vi.spyOn(response, 'json').mockImplementation(async () => {
      expect(cleared).toBe(true);
      return { error: { code: 'UNAUTHORIZED' } };
    });
    const client = createApiClient({
      apiBaseUrl: 'https://api.danyeodam.invalid',
      getAccessToken: async () => 'access-token',
      clearLocalSession: async () => {
        cleared = true;
      },
      fetch: async () => response,
    });

    await expect(client('/api/me/collection')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
    });
    expect(cleared).toBe(true);
  });

  it('does not clear a replacement session after a stale request returns 401', async () => {
    let currentAccessToken = 'old-access-token';
    let resolveResponse: ((response: Response) => void) | undefined;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const getAccessToken = vi.fn(async () => currentAccessToken as string | null);
    const clearLocalSession = vi.fn(async () => undefined);
    const requestFetch = vi.fn(async () => response);
    const client = createApiClient({
      apiBaseUrl: 'https://api.danyeodam.invalid',
      getAccessToken,
      clearLocalSession,
      fetch: requestFetch,
    });
    const pending = client('/api/me/collection').catch((error: unknown) => error);
    await vi.waitFor(() => expect(requestFetch).toHaveBeenCalledOnce());

    currentAccessToken = 'replacement-access-token';
    resolveResponse?.(Response.json({
      error: { code: 'UNAUTHORIZED' },
    }, { status: 401 }));

    await expect(pending).resolves.toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
    });
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(clearLocalSession).not.toHaveBeenCalled();
  });

  it('keeps only allowlisted structured error fields', async () => {
    const client = createApiClient({
      apiBaseUrl: 'https://api.danyeodam.invalid',
      getAccessToken: async () => 'access-token',
      clearLocalSession: async () => undefined,
      fetch: async () => Response.json({
        error: {
          code: 'LOW_ACCURACY',
          message: 'raw diagnostic text',
          request_id: '22222222-2222-4222-8222-222222222222',
          details: { retry: true, required_accuracy_m: 80 },
        },
      }, { status: 422 }),
    });

    await expect(client('/api/acquire')).rejects.toMatchObject({
      code: 'LOW_ACCURACY',
      details: { retry: true },
      requestId: '22222222-2222-4222-8222-222222222222',
      status: 422,
    });
  });

  it.each([
    ['MINIMUM_AGE_ATTESTATION_REQUIRED', 428],
    ['LOCATION_CONSENT_REQUIRED', 428],
    ['LOCATION_USE_PAUSED', 403],
    ['LOCATION_WITHDRAWAL_PENDING', 409],
    ['LOCATION_CORRECTION_PENDING', 409],
  ] as const)('preserves the location compliance error %s', async (code, status) => {
    const client = createApiClient({
      apiBaseUrl: 'https://api.danyeodam.invalid',
      getAccessToken: async () => 'access-token',
      clearLocalSession: async () => undefined,
      fetch: async () => Response.json({ error: { code } }, { status }),
    });

    await expect(client('/api/acquire')).rejects.toMatchObject({
      code,
      details: null,
      status,
    });
  });

  it('falls back to INTERNAL for an unrecognized server error code', async () => {
    const client = createApiClient({
      apiBaseUrl: 'https://api.danyeodam.invalid',
      getAccessToken: async () => 'access-token',
      clearLocalSession: async () => undefined,
      fetch: async () => Response.json({
        error: {
          code: 'secret-value-from-server',
          request_id: 'not-a-uuid',
          details: { token: 'must-not-survive' },
        },
      }, { status: 500 }),
    });

    const error = await client('/api/me/collection').catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      code: 'INTERNAL',
      details: null,
      requestId: null,
      status: 500,
    });
    expect(String(error)).not.toContain('secret-value-from-server');
    expect(JSON.stringify(error)).not.toContain('must-not-survive');
  });

  it('returns undefined for a successful 204 response', async () => {
    const client = createApiClient({
      apiBaseUrl: 'https://api.danyeodam.invalid',
      getAccessToken: async () => 'access-token',
      clearLocalSession: async () => undefined,
      fetch: async () => new Response(null, { status: 204 }),
    });

    await expect(client('/api/participants/redeem', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('classifies malformed successful responses without retaining their body', async () => {
    const client = createApiClient({
      apiBaseUrl: 'https://api.danyeodam.invalid',
      getAccessToken: async () => 'access-token',
      clearLocalSession: async () => undefined,
      fetch: async () => new Response('private response body', { status: 200 }),
    });

    const error = await client('/api/me/access').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiTransportError);
    expect(error).toMatchObject({ failure: 'INVALID_RESPONSE' });
    expect(String(error)).not.toContain('private response body');
  });

  it('rejects paths outside the fixed API boundary', async () => {
    const requestFetch = vi.fn();
    const client = createApiClient({
      apiBaseUrl: 'https://api.danyeodam.invalid',
      getAccessToken: async () => 'access-token',
      clearLocalSession: async () => undefined,
      fetch: requestFetch as typeof fetch,
    });

    await expect(client('//attacker.invalid/collect')).rejects.toMatchObject({
      failure: 'INVALID_RESPONSE',
    });
    await expect(client('/api/../outside')).rejects.toMatchObject({
      failure: 'INVALID_RESPONSE',
    });
    await expect(client('/api/%2e%2e/outside')).rejects.toMatchObject({
      failure: 'INVALID_RESPONSE',
    });
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it('fails closed when no authenticated session exists', async () => {
    const requestFetch = vi.fn();
    const client = createApiClient({
      apiBaseUrl: 'https://api.danyeodam.invalid',
      getAccessToken: async () => null,
      clearLocalSession: async () => undefined,
      fetch: requestFetch as typeof fetch,
    });

    await expect(client('/api/me/collection')).rejects.toMatchObject({
      failure: 'AUTH_SESSION_UNAVAILABLE',
    });
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it('aborts a request body read at the configured timeout', async () => {
    const client = createApiClient({
      apiBaseUrl: 'https://api.danyeodam.invalid',
      getAccessToken: async () => 'access-token',
      clearLocalSession: async () => undefined,
      timeoutMs: 5,
      fetch: async (_input, init) => {
        await new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
        throw new Error('unreachable');
      },
    });

    await expect(client('/api/me/collection')).rejects.toMatchObject({
      failure: 'TIMEOUT',
    });
  });
});
