import { describe, expect, it, vi } from 'vitest';

import {
  ApiResponseError,
  ApiTransportError,
  type ApiClient,
} from './client';
import {
  createOwnedPersonalCardPhotoLoader,
  createPersonalCardPhotoService,
  isPersonalCardUploadRetryable,
  MAX_PERSONAL_CARD_SOURCE_BYTES,
  parsePersonalCardCreation,
  parsePersonalCardUploadIssue,
  PersonalCardUploadError,
} from './personal-card-photo';

const userId = '11111111-1111-4111-8111-111111111111';
const uploadId = '22222222-2222-4222-8222-222222222222';
const acquisitionId = '33333333-3333-4333-8333-333333333333';
const personalCardId = '44444444-4444-4444-8444-444444444444';
const clientRequestId = '55555555-5555-4555-8555-555555555555';
const tempPath = `${userId}/${uploadId}.jpg`;
const supabaseUrl = 'https://project.supabase.co';
const uploadUrl = `${supabaseUrl}/storage/v1/object/upload/sign/personal-card-temp/${tempPath}?token=${'A'.repeat(40)}`;

function apiClient(
  implementation: (path: string, options?: unknown) => Promise<unknown>,
): ApiClient {
  const request = vi.fn(implementation) as unknown as ApiClient;
  request.cacheAware = vi.fn() as ApiClient['cacheAware'];
  return request;
}

describe('personal-card photo API contract', () => {
  it('accepts only a pinned Supabase signed-upload URL for the returned path', () => {
    expect(parsePersonalCardUploadIssue({
      upload_url: uploadUrl,
      temp_path: tempPath,
    }, supabaseUrl)).toEqual({ uploadUrl, tempPath });

    for (const unsafeUrl of [
      uploadUrl.replace('project.supabase.co', 'attacker.invalid'),
      uploadUrl.replace('/personal-card-temp/', '/other-bucket/'),
      `${uploadUrl}&next=https://attacker.invalid`,
      uploadUrl.replace('?token=', '#token='),
    ]) {
      expect(() => parsePersonalCardUploadIssue({
        upload_url: unsafeUrl,
        temp_path: tempPath,
      }, supabaseUrl)).toThrow(ApiTransportError);
    }
  });

  it('parses only the private creation response shape', () => {
    expect(parsePersonalCardCreation({
      personal_card: { id: personalCardId, share_slug: null },
    })).toEqual({ id: personalCardId });
    expect(() => parsePersonalCardCreation({
      personal_card: { id: personalCardId, share_slug: 'public-secret' },
    })).toThrow(ApiTransportError);
  });

  it('issues, uploads, and promotes without forwarding bearer credentials to storage', async () => {
    const client = apiClient(async (path) => {
      if (path === '/api/personal-cards/upload-url') {
        return { upload_url: uploadUrl, temp_path: tempPath };
      }
      return { personal_card: { id: personalCardId, share_slug: null } };
    });
    const uploadFetch = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => new Response(null, { status: 200 }));
    const service = createPersonalCardPhotoService({
      client,
      supabaseUrl,
      fetch: uploadFetch,
    });
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);

    const issue = await service.issueUpload({
      clientRequestId,
      contentType: 'image/jpeg',
      sizeBytes: bytes.byteLength,
    });
    await expect(service.upload({
      issue,
      bytes,
      contentType: 'image/jpeg',
    })).resolves.toBe('uploaded');
    await expect(service.create({
      acquisitionId,
      tempPath,
      caption: 'memory',
    })).resolves.toEqual({ id: personalCardId });

    expect(client).toHaveBeenNthCalledWith(1, '/api/personal-cards/upload-url', {
      method: 'POST',
      json: {
        client_request_id: clientRequestId,
        content_type: 'image/jpeg',
        size: bytes.byteLength,
      },
      signal: undefined,
    });
    expect(uploadFetch).toHaveBeenCalledWith(new URL(uploadUrl), expect.objectContaining({
      method: 'PUT',
      credentials: 'omit',
      redirect: 'error',
      headers: {
        'Cache-Control': 'max-age=3600',
        'Content-Type': 'image/jpeg',
        'X-Upsert': 'false',
      },
      body: expect.any(ArrayBuffer),
    }));
    expect(uploadFetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization');
    expect(client).toHaveBeenNthCalledWith(2, '/api/personal-cards', {
      method: 'POST',
      json: {
        acquisition_id: acquisitionId,
        temp_path: tempPath,
        caption: 'memory',
      },
      signal: undefined,
    });
  });

  it('treats a unique-object 409 as an already completed ambiguous PUT retry', async () => {
    const service = createPersonalCardPhotoService({
      client: apiClient(async () => ({})),
      supabaseUrl,
      fetch: async () => new Response(null, { status: 409 }),
    });
    await expect(service.upload({
      issue: { uploadUrl, tempPath },
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
      contentType: 'image/jpeg',
    })).resolves.toBe('already_uploaded');
  });

  it('fails a redirecting signed upload closed without following it', async () => {
    const requestFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      throw new TypeError('redirect mode is error');
    });
    const service = createPersonalCardPhotoService({
      client: apiClient(async () => ({})),
      supabaseUrl,
      fetch: requestFetch,
    });

    await expect(service.upload({
      issue: { uploadUrl, tempPath },
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
      contentType: 'image/jpeg',
    })).rejects.toMatchObject({ reason: 'NETWORK_ERROR' });
    expect(requestFetch).toHaveBeenCalledOnce();
  });

  it('aborts a stalled signed upload on the bounded upload timeout', async () => {
    const service = createPersonalCardPhotoService({
      client: apiClient(async () => ({})),
      supabaseUrl,
      uploadTimeoutMs: 5,
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      }),
    });

    await expect(service.upload({
      issue: { uploadUrl, tempPath },
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
      contentType: 'image/jpeg',
    })).rejects.toMatchObject({ reason: 'TIMEOUT' });
  });

  it('rejects invalid sizes before issuing another signed URL', async () => {
    const client = apiClient(async () => ({}));
    const service = createPersonalCardPhotoService({ client, supabaseUrl });

    await expect(service.issueUpload({
      clientRequestId,
      contentType: 'image/jpeg',
      sizeBytes: MAX_PERSONAL_CARD_SOURCE_BYTES + 1,
    })).rejects.toBeInstanceOf(PersonalCardUploadError);
    expect(client).not.toHaveBeenCalled();
  });
});

describe('owned personal-card photo transport', () => {
  const photoPath = `/api/personal-cards/${personalCardId}/photo`;

  it('fetches into a bounded in-memory blob with redirects and cookies disabled', async () => {
    const body = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });
    const requestFetch = vi.fn(async () => new Response(body, {
      headers: {
        'Content-Length': String(body.size),
        'Content-Type': 'image/webp',
      },
    }));
    const loader = createOwnedPersonalCardPhotoLoader({
      apiBaseUrl: 'https://api.danyeodam.test',
      getAccessToken: async () => 'private-access-token',
      clearLocalSession: async () => undefined,
      fetch: requestFetch,
    });

    await expect(loader({ photoPath, personalCardId })).resolves.toMatchObject({
      size: 3,
      type: 'image/webp',
    });
    expect(requestFetch).toHaveBeenCalledWith(
      new URL(`https://api.danyeodam.test${photoPath}`),
      expect.objectContaining({
        credentials: 'omit',
        redirect: 'error',
        headers: {
          Accept: 'image/webp',
          Authorization: 'Bearer private-access-token',
        },
      }),
    );
  });

  it('uses Response.blob and returns the native-compatible blob object unchanged', async () => {
    const body = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });
    const response = new Response(null, {
      headers: {
        'Content-Length': String(body.size),
        'Content-Type': 'image/webp',
      },
    });
    const blob = vi.spyOn(response, 'blob').mockResolvedValue(body);
    const loader = createOwnedPersonalCardPhotoLoader({
      apiBaseUrl: 'https://api.danyeodam.test',
      getAccessToken: async () => 'token',
      clearLocalSession: async () => undefined,
      fetch: async () => response,
    });

    await expect(loader({ photoPath, personalCardId })).resolves.toBe(body);
    expect(blob).toHaveBeenCalledOnce();
  });

  it('rejects a photo path that does not match the personal-card id before auth', async () => {
    const getAccessToken = vi.fn(async () => 'unused');
    const requestFetch = vi.fn();
    const loader = createOwnedPersonalCardPhotoLoader({
      apiBaseUrl: 'https://api.danyeodam.test',
      getAccessToken,
      clearLocalSession: async () => undefined,
      fetch: requestFetch as typeof fetch,
    });

    await expect(loader({
      photoPath,
      personalCardId: acquisitionId,
    })).rejects.toMatchObject({ failure: 'INVALID_RESPONSE' });
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it('clears only the unchanged local session after a protected 401', async () => {
    const clearLocalSession = vi.fn(async () => undefined);
    const loader = createOwnedPersonalCardPhotoLoader({
      apiBaseUrl: 'https://api.danyeodam.test',
      getAccessToken: async () => 'same-token',
      clearLocalSession,
      fetch: async () => new Response(null, { status: 401 }),
    });

    await expect(loader({ photoPath, personalCardId })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
    });
    expect(clearLocalSession).toHaveBeenCalledOnce();
  });

  it('rejects a mislabeled or oversized private photo before creating an object URL', async () => {
    const loader = createOwnedPersonalCardPhotoLoader({
      apiBaseUrl: 'https://api.danyeodam.test',
      getAccessToken: async () => 'token',
      clearLocalSession: async () => undefined,
      fetch: async () => new Response('not an image', {
        headers: {
          'Content-Length': '12',
          'Content-Type': 'text/plain',
        },
      }),
    });

    await expect(loader({ photoPath, personalCardId })).rejects.toMatchObject({
      failure: 'INVALID_RESPONSE',
    });
  });

  it('closes a native Blob whose actual metadata contradicts trusted headers', async () => {
    const close = vi.fn();
    const invalidBlob = Object.assign(
      new Blob([new Uint8Array([1, 2])], { type: 'image/webp' }),
      { close },
    );
    const response = new Response(null, {
      headers: {
        'Content-Length': '3',
        'Content-Type': 'image/webp',
      },
    });
    vi.spyOn(response, 'blob').mockResolvedValue(invalidBlob);
    const loader = createOwnedPersonalCardPhotoLoader({
      apiBaseUrl: 'https://api.danyeodam.test',
      getAccessToken: async () => 'token',
      clearLocalSession: async () => undefined,
      fetch: async () => response,
    });

    await expect(loader({ photoPath, personalCardId })).rejects.toMatchObject({
      failure: 'INVALID_RESPONSE',
    });
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('personal-card retry policy', () => {
  it('retains only failures that can safely continue the same temp path', () => {
    expect(isPersonalCardUploadRetryable(new ApiTransportError('NETWORK_ERROR'))).toBe(true);
    expect(isPersonalCardUploadRetryable(new ApiTransportError('INVALID_RESPONSE'))).toBe(false);
    expect(isPersonalCardUploadRetryable(new ApiResponseError({
      code: 'VALIDATION_FAILED',
      status: 409,
      requestId: null,
      details: { reason: 'upload_processing' },
    }))).toBe(true);
    expect(isPersonalCardUploadRetryable(new ApiResponseError({
      code: 'VALIDATION_FAILED',
      status: 400,
      requestId: null,
      details: { reason: 'upload_expired' },
    }))).toBe(false);
    expect(isPersonalCardUploadRetryable(new ApiResponseError({
      code: 'POLICY_ACCEPTANCE_REQUIRED',
      status: 409,
      requestId: null,
      details: {
        required: [
          { type: 'terms_of_use', version: '2026-08-12' },
          { type: 'community_guidelines', version: '2026-08-12' },
        ],
      },
    }))).toBe(true);
  });
});
