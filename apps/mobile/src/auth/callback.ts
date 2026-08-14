type CallbackParameters = {
  code: string;
  flowId: string;
};

export type AuthCallbackGateway = {
  consumePending(flowId: string): Promise<{
    verifier: string;
    authUserId: string;
  } | null>;
  exchangeCode(code: string, verifier: string): Promise<{
    accessToken: string;
    refreshToken: string;
    authUserId: string;
  }>;
  setSession(tokens: {
    access_token: string;
    refresh_token: string;
  }): Promise<{
    data: { session: { user: { id: string } } | null };
    error: unknown | null;
  }>;
  clearSession(): Promise<void>;
};

const FLOW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_AUTH_CODE_LENGTH = 4_096;
const REJECTED_CALLBACK_FIELDS = new Set([
  'error',
  'error_code',
  'error_description',
  'sb_flow_id',
]);

function singleParameter(parameters: URLSearchParams, name: string): string | null {
  const values = parameters.getAll(name);
  return values.length === 1 && values[0] ? values[0] : null;
}

export function parseAuthCallback(url: string): CallbackParameters {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'danyeodam:'
    || parsed.hostname !== 'auth'
    || parsed.pathname !== '/callback'
  ) {
    throw new Error('AUTH_CALLBACK_NOT_ALLOWED');
  }

  if (parsed.hash !== '') {
    throw new Error('AUTH_CALLBACK_INVALID');
  }
  const parameters = new URLSearchParams(parsed.search);

  if (
    parameters.has('error')
    || parameters.has('error_code')
    || parameters.has('error_description')
  ) {
    throw new Error('AUTH_CALLBACK_REJECTED');
  }

  const code = singleParameter(parameters, 'code');
  const flowId = singleParameter(parameters, 'sb_flow_id');
  if (
    code === null
    || code.length > MAX_AUTH_CODE_LENGTH
    || flowId === null
    || !FLOW_ID_PATTERN.test(flowId)
    || [...parameters.keys()].some((name) => name !== 'code' && name !== 'sb_flow_id')
  ) {
    throw new Error('AUTH_CALLBACK_INVALID');
  }
  return { code, flowId };
}

export function parseRejectedAuthCallbackFlowId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'danyeodam:'
      || parsed.hostname !== 'auth'
      || parsed.pathname !== '/callback'
      || parsed.hash !== ''
    ) {
      return null;
    }
    const parameters = new URLSearchParams(parsed.search);
    if (
      !parameters.has('error')
      || [...parameters.keys()].some((name) => !REJECTED_CALLBACK_FIELDS.has(name))
    ) {
      return null;
    }
    const flowId = singleParameter(parameters, 'sb_flow_id');
    return flowId !== null && FLOW_ID_PATTERN.test(flowId) ? flowId : null;
  } catch {
    return null;
  }
}

export async function completeAuthCallback(
  url: string,
  auth: AuthCallbackGateway,
): Promise<void> {
  const callback = parseAuthCallback(url);
  const pending = await auth.consumePending(callback.flowId);
  if (pending === null) {
    throw new Error('AUTH_CALLBACK_FLOW_NOT_FOUND');
  }

  const exchanged = await auth.exchangeCode(callback.code, pending.verifier);
  if (exchanged.authUserId.toLowerCase() !== pending.authUserId.toLowerCase()) {
    throw new Error('AUTH_CALLBACK_USER_MISMATCH');
  }

  const result = await auth.setSession({
    access_token: exchanged.accessToken,
    refresh_token: exchanged.refreshToken,
  });
  if (
    result.error !== null
    || result.data.session === null
    || result.data.session.user.id.toLowerCase() !== pending.authUserId.toLowerCase()
  ) {
    await auth.clearSession().catch(() => undefined);
    throw new Error('AUTH_CALLBACK_EXCHANGE_FAILED');
  }
}
