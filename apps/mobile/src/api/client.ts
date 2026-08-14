import { fetch as expoFetch } from 'expo/fetch';

import type { SupportedLocale } from '@/i18n/locales';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

type ApiErrorEnvelope = {
  error: {
    code: string;
    request_id?: string;
    details?: Record<string, unknown>;
  };
};

const API_ERROR_CODES = new Set([
  'ACCOUNT_SUSPENDED',
  'ALREADY_ACQUIRED_TODAY',
  'EMAIL_ALREADY_IN_USE',
  'FORBIDDEN',
  'GATE_CLOSED',
  'IDEMPOTENCY_CONFLICT',
  'INTERNAL',
  'LOW_ACCURACY',
  'LOCATION_CONSENT_REQUIRED',
  'LOCATION_CORRECTION_PENDING',
  'LOCATION_USE_PAUSED',
  'LOCATION_WITHDRAWAL_PENDING',
  'MINIMUM_AGE_ATTESTATION_REQUIRED',
  'MODERATION_CONFLICT',
  'NOT_FOUND',
  'OUT_OF_RANGE',
  'POLICY_ACCEPTANCE_REQUIRED',
  'QUOTA_EXCEEDED',
  'RATE_LIMITED',
  'RECOVERY_CONFLICT',
  'SPOT_NOT_OPEN',
  'UNAUTHORIZED',
  'VALIDATION_FAILED',
]);

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DELETION_STATUS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const DELETION_STATUS_PATH_PATTERN = /^\/api\/account\/deletion-requests\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ETAG_PATTERN = /^(?:W\/)?"[^"\r\n]{1,200}"$/u;

export type ApiRequestOptions = {
  method?: HttpMethod;
  authenticated?: boolean;
  deletionStatusToken?: string;
  expectedStatus?: number;
  json?: unknown;
  locale?: SupportedLocale;
  signal?: AbortSignal;
};

export type ApiCacheRequestOptions = Omit<
  ApiRequestOptions,
  'expectedStatus' | 'json' | 'method'
> & {
  ifNoneMatch?: string;
};

export type ApiCacheAwareResult<T> =
  | { status: 'fresh'; data: T; etag: string | null }
  | { status: 'not_modified'; etag: string | null };

export type ApiClient = {
  <T>(path: string, options?: ApiRequestOptions): Promise<T>;
  cacheAware<T>(
    path: string,
    options?: ApiCacheRequestOptions,
  ): Promise<ApiCacheAwareResult<T>>;
};

export type ApiClientDependencies = {
  apiBaseUrl: string;
  getAccessToken(): Promise<string | null>;
  clearLocalSession(): Promise<void>;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type ApiTransportFailure =
  | 'ABORTED'
  | 'AUTH_SESSION_UNAVAILABLE'
  | 'INVALID_RESPONSE'
  | 'NETWORK_ERROR'
  | 'TIMEOUT';

export class ApiResponseError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;
  readonly details: Readonly<Record<string, unknown>> | null;

  constructor(input: {
    code: string;
    status: number;
    requestId: string | null;
    details: Record<string, unknown> | null;
  }) {
    super(`API request failed with ${input.code}.`);
    this.name = 'ApiResponseError';
    this.code = input.code;
    this.status = input.status;
    this.requestId = input.requestId;
    this.details = input.details;
  }
}

export class ApiTransportError extends Error {
  readonly failure: ApiTransportFailure;

  constructor(failure: ApiTransportFailure) {
    super(`API transport failed with ${failure}.`);
    this.name = 'ApiTransportError';
    this.failure = failure;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeRequestId(value: string | null | undefined): string | null {
  return value !== null && value !== undefined && REQUEST_ID_PATTERN.test(value)
    ? value
    : null;
}

function safeEtag(value: string | null | undefined): string | null {
  return value !== null && value !== undefined && ETAG_PATTERN.test(value)
    ? value
    : null;
}

function safeEnum(value: unknown, values: readonly string[]): string | null {
  return typeof value === 'string' && values.includes(value) ? value : null;
}

function sanitizeErrorDetails(
  code: string,
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (details === undefined) {
    return null;
  }
  if (code === 'OUT_OF_RANGE') {
    const distanceBand = safeEnum(details.distance_band, ['near', 'far']);
    return distanceBand === null ? null : { distance_band: distanceBand };
  }
  if (code === 'LOW_ACCURACY') {
    return details.retry === true ? { retry: true } : null;
  }
  if (code === 'VALIDATION_FAILED') {
    const reason = safeEnum(details.reason, ['upload_expired', 'upload_processing']);
    return reason === null ? null : { reason };
  }
  if (code === 'GATE_CLOSED') {
    const gate = safeEnum(details.gate, ['share_creation']);
    return gate === null ? null : { gate };
  }
  if (code === 'RECOVERY_CONFLICT') {
    const reason = safeEnum(details.reason, ['not_empty']);
    return reason === null ? null : { reason };
  }
  if (code === 'MODERATION_CONFLICT') {
    const reason = safeEnum(details.reason, ['policy_resubmission_required']);
    return reason === null ? null : { reason };
  }
  if (code === 'RATE_LIMITED') {
    const result: Record<string, number> = {};
    if (Number.isInteger(details.locked_minutes) && Number(details.locked_minutes) >= 0) {
      result.locked_minutes = Number(details.locked_minutes);
    }
    if (
      Number.isInteger(details.retry_after_seconds)
      && Number(details.retry_after_seconds) >= 0
    ) {
      result.retry_after_seconds = Number(details.retry_after_seconds);
    }
    return Object.keys(result).length === 0 ? null : result;
  }
  if (code === 'POLICY_ACCEPTANCE_REQUIRED' && Array.isArray(details.required)) {
    const required = details.required.slice(0, 10).flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.type !== 'string' || typeof entry.version !== 'string') {
        return [];
      }
      if (entry.type.length > 100 || entry.version.length > 100) {
        return [];
      }
      return [{ type: entry.type, version: entry.version }];
    });
    return required.length === 0 ? null : { required };
  }
  return null;
}

function parseErrorEnvelope(value: unknown): ApiErrorEnvelope | null {
  if (!isRecord(value) || !isRecord(value.error)) {
    return null;
  }
  const code = value.error.code;
  const requestId = value.error.request_id;
  const details = value.error.details;
  if (
    typeof code !== 'string'
    || !API_ERROR_CODES.has(code)
    || (requestId !== undefined && typeof requestId !== 'string')
    || (details !== undefined && !isRecord(details))
  ) {
    return null;
  }
  const safeId = safeRequestId(requestId);
  const safeDetails = sanitizeErrorDetails(code, details);
  return {
    error: {
      code,
      ...(safeId === null ? {} : { request_id: safeId }),
      ...(safeDetails === null ? {} : { details: safeDetails }),
    },
  };
}

function resolveEndpoint(apiBaseUrl: string, path: string): URL {
  if (path !== '/api' && !path.startsWith('/api/') && !path.startsWith('/api?')) {
    throw new ApiTransportError('INVALID_RESPONSE');
  }
  const base = new URL(`${apiBaseUrl.replace(/\/$/u, '')}/`);
  const endpoint = new URL(path, base);
  if (
    endpoint.origin !== base.origin
    || (endpoint.pathname !== '/api' && !endpoint.pathname.startsWith('/api/'))
  ) {
    throw new ApiTransportError('INVALID_RESPONSE');
  }
  return endpoint;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function createApiClient(dependencies: ApiClientDependencies): ApiClient {
  // React Native's global fetch currently drops RequestInit.redirect before
  // reaching the native transport. Expo fetch carries redirect='error' into
  // the iOS and Android request implementations, so secrets cannot be
  // forwarded by an unexpected 30x response. Tests may inject a transport,
  // but production must never fall back to the React Native global fetch.
  const requestFetch = dependencies.fetch ?? (expoFetch as typeof fetch);
  const timeoutMs = dependencies.timeoutMs ?? 10_000;

  async function requestInternal<T>(
    path: string,
    options: ApiRequestOptions & { ifNoneMatch?: string } = {},
    cacheAware = false,
  ): Promise<T | ApiCacheAwareResult<T>> {
    const endpoint = resolveEndpoint(dependencies.apiBaseUrl, path);
    const method = options.method ?? 'GET';
    if (
      options.expectedStatus !== undefined
      && (
        !Number.isSafeInteger(options.expectedStatus)
        || options.expectedStatus < 200
        || options.expectedStatus > 299
      )
    ) {
      throw new ApiTransportError('INVALID_RESPONSE');
    }
    const requestEtag = safeEtag(options.ifNoneMatch);
    if (options.ifNoneMatch !== undefined && requestEtag === null) {
      throw new ApiTransportError('INVALID_RESPONSE');
    }
    const authenticated = options.authenticated ?? true;
    if (
      options.deletionStatusToken !== undefined
      && (
        authenticated
        || method !== 'GET'
        || !DELETION_STATUS_PATH_PATTERN.test(endpoint.pathname)
        || !DELETION_STATUS_TOKEN_PATTERN.test(options.deletionStatusToken)
      )
    ) {
      throw new ApiTransportError('INVALID_RESPONSE');
    }
    let accessToken: string | null = null;
    if (authenticated) {
      try {
        accessToken = await dependencies.getAccessToken();
      } catch {
        throw new ApiTransportError('AUTH_SESSION_UNAVAILABLE');
      }
      if (accessToken === null) {
        throw new ApiTransportError('AUTH_SESSION_UNAVAILABLE');
      }
    }

    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort();
    if (options.signal?.aborted) {
      controller.abort();
    } else {
      options.signal?.addEventListener('abort', abortFromCaller, { once: true });
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (accessToken !== null) {
      headers.Authorization = `Bearer ${accessToken}`;
    }
    if (options.locale !== undefined) {
      headers['Accept-Language'] = options.locale;
    }
    if (requestEtag !== null) {
      headers['If-None-Match'] = requestEtag;
    }
    if (options.deletionStatusToken !== undefined) {
      headers['X-Deletion-Status-Token'] = options.deletionStatusToken;
    }
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    try {
      let response: Response;
      try {
        response = await requestFetch(endpoint, {
          method,
          headers,
          // Native API authorization is bearer-only. The web target must not
          // inherit ambient same-origin cookies for any mobile API request.
          credentials: 'omit',
          // No mobile API contract uses redirects. Failing closed prevents a
          // proxy or origin misconfiguration from forwarding deletion status
          // tokens, share secrets, or authenticated request bodies elsewhere.
          redirect: 'error',
          ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) {
          throw new ApiTransportError(timedOut ? 'TIMEOUT' : 'ABORTED');
        }
        throw new ApiTransportError('NETWORK_ERROR');
      }

      const headerRequestId = safeRequestId(response.headers.get('x-request-id'));
      const responseEtag = safeEtag(response.headers.get('etag'));
      if (response.status === 304 && cacheAware) {
        return {
          status: 'not_modified',
          etag: responseEtag ?? requestEtag,
        };
      }
      if (
        response.ok
        && options.expectedStatus !== undefined
        && response.status !== options.expectedStatus
      ) {
        throw new ApiTransportError('INVALID_RESPONSE');
      }
      if (response.status === 204 && response.ok) {
        if (cacheAware) {
          throw new ApiTransportError('INVALID_RESPONSE');
        }
        return undefined as T;
      }
      if (response.status === 401 && authenticated) {
        let currentAccessToken: string | null;
        try {
          currentAccessToken = await dependencies.getAccessToken();
        } catch {
          throw new ApiTransportError('AUTH_SESSION_UNAVAILABLE');
        }
        if (currentAccessToken === accessToken) {
          try {
            await dependencies.clearLocalSession();
          } catch {
            throw new ApiTransportError('AUTH_SESSION_UNAVAILABLE');
          }
        }
      }
      const payload = await readJson(response);
      if (controller.signal.aborted) {
        throw new ApiTransportError(timedOut ? 'TIMEOUT' : 'ABORTED');
      }
      if (response.ok) {
        if (payload === null) {
          throw new ApiTransportError('INVALID_RESPONSE');
        }
        return cacheAware
          ? { status: 'fresh', data: payload as T, etag: responseEtag }
          : payload as T;
      }

      const envelope = parseErrorEnvelope(payload);
      throw new ApiResponseError({
        code: envelope?.error.code ?? 'INTERNAL',
        status: response.status,
        requestId: envelope?.error.request_id ?? headerRequestId,
        details: envelope?.error.details ?? null,
      });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  const request = (<T>(path: string, options: ApiRequestOptions = {}) => (
    requestInternal<T>(path, options) as Promise<T>
  )) as ApiClient;
  request.cacheAware = <T>(path: string, options: ApiCacheRequestOptions = {}) => (
    requestInternal<T>(path, options, true) as Promise<ApiCacheAwareResult<T>>
  );
  return request;
}
