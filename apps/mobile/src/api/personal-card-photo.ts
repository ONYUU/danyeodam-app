import { fetch as expoFetch } from 'expo/fetch';

import {
  ApiResponseError,
  ApiTransportError,
  type ApiClient,
} from './client';
import {
  expectRecord,
  expectString,
  expectUuid,
  invalidPayload,
} from './payload';
import { closeNativeBlobIfSupported } from './native-blob';

export const PERSONAL_CARD_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export type PersonalCardContentType = (typeof PERSONAL_CARD_CONTENT_TYPES)[number];

export const MAX_PERSONAL_CARD_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_PERSONAL_CARD_DERIVED_BYTES = 5 * 1024 * 1024;
export const MAX_PERSONAL_CARD_CAPTION_LENGTH = 60;

const TEMP_PATH_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/iu;
const PERSONAL_CARD_PHOTO_PATH_PATTERN = /^\/api\/personal-cards\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/photo$/iu;
const SIGNED_UPLOAD_PATH_PREFIX = '/storage/v1/object/upload/sign/personal-card-temp/';

export type PersonalCardUploadIssue = {
  uploadUrl: string;
  tempPath: string;
};

export type PersonalCardCreation = {
  id: string;
};

export type PersonalCardPhotoService = {
  issueUpload(input: {
    clientRequestId: string;
    contentType: PersonalCardContentType;
    sizeBytes: number;
    signal?: AbortSignal;
  }): Promise<PersonalCardUploadIssue>;
  upload(input: {
    issue: PersonalCardUploadIssue;
    bytes: Uint8Array;
    contentType: PersonalCardContentType;
    signal?: AbortSignal;
  }): Promise<'uploaded' | 'already_uploaded'>;
  create(input: {
    acquisitionId: string;
    tempPath: string;
    caption: string;
    signal?: AbortSignal;
  }): Promise<PersonalCardCreation>;
};

export class PersonalCardUploadError extends Error {
  readonly reason:
    | 'ABORTED'
    | 'NETWORK_ERROR'
    | 'REJECTED'
    | 'TIMEOUT';
  readonly status: number | null;

  constructor(reason: PersonalCardUploadError['reason'], status: number | null = null) {
    super(`Personal card upload failed with ${reason}.`);
    this.name = 'PersonalCardUploadError';
    this.reason = reason;
    this.status = status;
  }
}

function parseTemporaryPath(value: unknown): string {
  return expectString(value, {
    minimumLength: 74,
    maximumLength: 128,
    pattern: TEMP_PATH_PATTERN,
  });
}

function normalizeOrigin(value: string): string {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.pathname !== '/'
      || parsed.search !== ''
      || parsed.hash !== ''
    ) {
      return invalidPayload();
    }
    return parsed.origin;
  } catch {
    return invalidPayload();
  }
}

function parseSignedUploadUrl(
  value: unknown,
  tempPath: string,
  supabaseUrl: string,
): string {
  const candidate = expectString(value, {
    minimumLength: 1,
    maximumLength: 8_192,
  });
  try {
    const parsed = new URL(candidate);
    const expectedPath = `${SIGNED_UPLOAD_PATH_PREFIX}${tempPath}`;
    const queryKeys = [...parsed.searchParams.keys()];
    const token = parsed.searchParams.get('token');
    if (
      parsed.origin !== normalizeOrigin(supabaseUrl)
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.hash !== ''
      || decodeURIComponent(parsed.pathname) !== expectedPath
      || queryKeys.length !== 1
      || queryKeys[0] !== 'token'
      || token === null
      || token.length < 20
      || token.length > 8_000
    ) {
      return invalidPayload();
    }
    return parsed.toString();
  } catch {
    return invalidPayload();
  }
}

export function parsePersonalCardUploadIssue(
  value: unknown,
  supabaseUrl: string,
): PersonalCardUploadIssue {
  const record = expectRecord(value);
  const tempPath = parseTemporaryPath(record.temp_path);
  return {
    tempPath,
    uploadUrl: parseSignedUploadUrl(record.upload_url, tempPath, supabaseUrl),
  };
}

export function parsePersonalCardCreation(value: unknown): PersonalCardCreation {
  const record = expectRecord(value);
  const personalCard = expectRecord(record.personal_card);
  if (personalCard.share_slug !== null) {
    return invalidPayload();
  }
  return { id: expectUuid(personalCard.id) };
}

function createCombinedSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  didTimeout(): boolean;
  cleanup(): void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort();
  if (parentSignal?.aborted) {
    controller.abort();
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup() {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

function validateUploadInput(input: {
  issue: PersonalCardUploadIssue;
  bytes: Uint8Array;
  contentType: PersonalCardContentType;
}) {
  if (
    input.bytes.byteLength < 1
    || input.bytes.byteLength > MAX_PERSONAL_CARD_SOURCE_BYTES
    || !PERSONAL_CARD_CONTENT_TYPES.includes(input.contentType)
    || !TEMP_PATH_PATTERN.test(input.issue.tempPath)
  ) {
    throw new PersonalCardUploadError('REJECTED');
  }
}

function copyUploadBody(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const body = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  body.set(bytes);
  return body;
}

export function createPersonalCardPhotoService(dependencies: {
  client: ApiClient;
  supabaseUrl: string;
  fetch?: typeof fetch;
  uploadTimeoutMs?: number;
}): PersonalCardPhotoService {
  const uploadFetch = dependencies.fetch ?? (expoFetch as typeof fetch);
  const uploadTimeoutMs = dependencies.uploadTimeoutMs ?? 45_000;

  return {
    async issueUpload(input) {
      const clientRequestId = expectUuid(input.clientRequestId);
      if (
        !PERSONAL_CARD_CONTENT_TYPES.includes(input.contentType)
        || !Number.isSafeInteger(input.sizeBytes)
        || input.sizeBytes < 1
        || input.sizeBytes > MAX_PERSONAL_CARD_SOURCE_BYTES
      ) {
        throw new PersonalCardUploadError('REJECTED');
      }
      const payload = await dependencies.client<unknown>('/api/personal-cards/upload-url', {
        method: 'POST',
        json: {
          content_type: input.contentType,
          size: input.sizeBytes,
          client_request_id: clientRequestId,
        },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      return parsePersonalCardUploadIssue(payload, dependencies.supabaseUrl);
    },

    async upload(input) {
      validateUploadInput(input);
      const parsedIssue = parsePersonalCardUploadIssue({
        upload_url: input.issue.uploadUrl,
        temp_path: input.issue.tempPath,
      }, dependencies.supabaseUrl);
      const scoped = createCombinedSignal(input.signal, uploadTimeoutMs);
      const uploadBody = copyUploadBody(input.bytes);
      try {
        let response: Response;
        try {
          response = await uploadFetch(new URL(parsedIssue.uploadUrl), {
            method: 'PUT',
            headers: {
              'Cache-Control': 'max-age=3600',
              'Content-Type': input.contentType,
              'X-Upsert': 'false',
            },
            body: uploadBody.buffer,
            credentials: 'omit',
            redirect: 'error',
            signal: scoped.signal,
          });
        } catch {
          if (scoped.signal.aborted) {
            throw new PersonalCardUploadError(
              scoped.didTimeout() ? 'TIMEOUT' : 'ABORTED',
            );
          }
          throw new PersonalCardUploadError('NETWORK_ERROR');
        }

        if (response.ok) {
          return 'uploaded';
        }
        // A retry after an ambiguous transport result may find that the first
        // PUT already created this unique, non-upsertable object.
        if (response.status === 409) {
          return 'already_uploaded';
        }
        throw new PersonalCardUploadError('REJECTED', response.status);
      } finally {
        uploadBody.fill(0);
        scoped.cleanup();
      }
    },

    async create(input) {
      const acquisitionId = expectUuid(input.acquisitionId);
      const caption = expectString(input.caption, {
        maximumLength: MAX_PERSONAL_CARD_CAPTION_LENGTH,
      });
      const payload = await dependencies.client<unknown>('/api/personal-cards', {
        method: 'POST',
        json: {
          acquisition_id: acquisitionId,
          temp_path: parseTemporaryPath(input.tempPath),
          caption,
        },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      return parsePersonalCardCreation(payload);
    },
  };
}

export type OwnedPersonalCardPhotoLoader = (input: {
  photoPath: string;
  personalCardId: string;
  signal?: AbortSignal;
}) => Promise<Blob>;

function resolveOwnedPhotoEndpoint(
  apiBaseUrl: string,
  photoPath: string,
  personalCardId: string,
): URL {
  const match = PERSONAL_CARD_PHOTO_PATH_PATTERN.exec(photoPath);
  if (match?.[1]?.toLowerCase() !== personalCardId.toLowerCase()) {
    return invalidPayload();
  }
  const base = new URL(`${apiBaseUrl.replace(/\/$/u, '')}/`);
  const endpoint = new URL(photoPath, base);
  if (endpoint.origin !== base.origin || endpoint.pathname !== photoPath) {
    return invalidPayload();
  }
  return endpoint;
}

export function createOwnedPersonalCardPhotoLoader(dependencies: {
  apiBaseUrl: string;
  getAccessToken(): Promise<string | null>;
  clearLocalSession(): Promise<void>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): OwnedPersonalCardPhotoLoader {
  const requestFetch = dependencies.fetch ?? (expoFetch as typeof fetch);
  const timeoutMs = dependencies.timeoutMs ?? 15_000;

  return async (input) => {
    const endpoint = resolveOwnedPhotoEndpoint(
      dependencies.apiBaseUrl,
      input.photoPath,
      input.personalCardId,
    );
    let accessToken: string | null;
    try {
      accessToken = await dependencies.getAccessToken();
    } catch {
      throw new ApiTransportError('AUTH_SESSION_UNAVAILABLE');
    }
    if (accessToken === null) {
      throw new ApiTransportError('AUTH_SESSION_UNAVAILABLE');
    }

    const scoped = createCombinedSignal(input.signal, timeoutMs);
    try {
      let response: Response;
      try {
        response = await requestFetch(endpoint, {
          method: 'GET',
          headers: {
            Accept: 'image/webp',
            Authorization: `Bearer ${accessToken}`,
          },
          credentials: 'omit',
          redirect: 'error',
          signal: scoped.signal,
        });
      } catch {
        if (scoped.signal.aborted) {
          throw new ApiTransportError(scoped.didTimeout() ? 'TIMEOUT' : 'ABORTED');
        }
        throw new ApiTransportError('NETWORK_ERROR');
      }

      if (response.status === 401) {
        let currentToken: string | null;
        try {
          currentToken = await dependencies.getAccessToken();
        } catch {
          throw new ApiTransportError('AUTH_SESSION_UNAVAILABLE');
        }
        if (currentToken === accessToken) {
          try {
            await dependencies.clearLocalSession();
          } catch {
            throw new ApiTransportError('AUTH_SESSION_UNAVAILABLE');
          }
        }
        throw new ApiResponseError({
          code: 'UNAUTHORIZED',
          status: 401,
          requestId: null,
          details: null,
        });
      }
      if (!response.ok) {
        throw new ApiResponseError({
          code: response.status === 404 ? 'NOT_FOUND' : 'INTERNAL',
          status: response.status,
          requestId: null,
          details: null,
        });
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (
        response.headers.get('content-type') !== 'image/webp'
        || !Number.isSafeInteger(declaredLength)
        || declaredLength < 1
        || declaredLength > MAX_PERSONAL_CARD_DERIVED_BYTES
      ) {
        throw new ApiTransportError('INVALID_RESPONSE');
      }
      const blob = await response.blob();
      let accepted = false;
      try {
        if (scoped.signal.aborted) {
          throw new ApiTransportError(scoped.didTimeout() ? 'TIMEOUT' : 'ABORTED');
        }
        if (
          blob.type !== 'image/webp'
          || blob.size !== declaredLength
          || blob.size > MAX_PERSONAL_CARD_DERIVED_BYTES
        ) {
          throw new ApiTransportError('INVALID_RESPONSE');
        }
        accepted = true;
        return blob;
      } finally {
        if (!accepted) {
          closeNativeBlobIfSupported(blob);
        }
      }
    } finally {
      scoped.cleanup();
    }
  };
}

export function isPersonalCardUploadRetryable(error: unknown): boolean {
  if (error instanceof PersonalCardUploadError) {
    return error.reason === 'NETWORK_ERROR'
      || error.reason === 'TIMEOUT'
      || (error.reason === 'REJECTED' && (error.status ?? 0) >= 500);
  }
  if (error instanceof ApiTransportError) {
    return error.failure !== 'AUTH_SESSION_UNAVAILABLE'
      && error.failure !== 'INVALID_RESPONSE';
  }
  if (error instanceof ApiResponseError) {
    return error.code === 'RATE_LIMITED'
      || error.code === 'INTERNAL'
      || error.code === 'POLICY_ACCEPTANCE_REQUIRED'
      || (
        error.code === 'VALIDATION_FAILED'
        && error.details?.reason === 'upload_processing'
      );
  }
  return false;
}
