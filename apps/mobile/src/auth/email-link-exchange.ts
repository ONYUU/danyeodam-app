type RecordValue = Record<string, unknown>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_RESPONSE_BYTES = 64 * 1_024;
const MAX_TOKEN_LENGTH = 16_384;

export type ExchangedEmailLinkSession = {
  accessToken: string;
  refreshToken: string;
  authUserId: string;
};

export type EmailLinkExchangeDependencies = {
  supabaseUrl: string;
  publishableKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseExchangeResponse(raw: string): ExchangedEmailLinkSession | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || !isRecord(value.user)) {
      return null;
    }
    const accessToken = value.access_token;
    const refreshToken = value.refresh_token;
    const authUserId = value.user.id;
    if (
      typeof accessToken !== 'string'
      || accessToken.length < 1
      || accessToken.length > MAX_TOKEN_LENGTH
      || typeof refreshToken !== 'string'
      || refreshToken.length < 1
      || refreshToken.length > MAX_TOKEN_LENGTH
      || typeof authUserId !== 'string'
      || !UUID_PATTERN.test(authUserId)
    ) {
      return null;
    }
    return { accessToken, refreshToken, authUserId: authUserId.toLowerCase() };
  } catch {
    return null;
  }
}

export function createEmailLinkCodeExchange(
  dependencies: EmailLinkExchangeDependencies,
) {
  const requestFetch = dependencies.fetch ?? fetch;
  const timeoutMs = dependencies.timeoutMs ?? 10_000;
  const endpoint = new URL('/auth/v1/token?grant_type=pkce', dependencies.supabaseUrl);

  return async function exchangeEmailLinkCode(
    authCode: string,
    verifier: string,
  ): Promise<ExchangedEmailLinkSession> {
    if (authCode.length < 1 || authCode.length > 4_096 || !VERIFIER_PATTERN.test(verifier)) {
      throw new Error('AUTH_CALLBACK_EXCHANGE_FAILED');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      apikey: dependencies.publishableKey,
      'Content-Type': 'application/json',
    };
    if (!dependencies.publishableKey.startsWith('sb_publishable_')) {
      headers.Authorization = `Bearer ${dependencies.publishableKey}`;
    }

    try {
      const response = await requestFetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          auth_code: authCode,
          code_verifier: verifier,
        }),
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok || raw.length > MAX_RESPONSE_BYTES) {
        throw new Error('AUTH_CALLBACK_EXCHANGE_FAILED');
      }
      const result = parseExchangeResponse(raw);
      if (result === null) {
        throw new Error('AUTH_CALLBACK_EXCHANGE_FAILED');
      }
      return result;
    } catch {
      throw new Error('AUTH_CALLBACK_EXCHANGE_FAILED');
    } finally {
      clearTimeout(timeout);
    }
  };
}
