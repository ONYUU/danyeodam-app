import { createApiClient, type ApiClient } from './client';

type PublicPolicyTransportInput = {
  apiBaseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export function createPublicPolicyApiClient(
  input: PublicPolicyTransportInput,
): ApiClient {
  return createApiClient({
    apiBaseUrl: input.apiBaseUrl,
    // This policy-only transport is incapable of reading or mutating a session.
    // Public policy/support access must remain outside age and auth gates.
    async getAccessToken() {
      return null;
    },
    async clearLocalSession() {
      // A public 401 must never clear an unrelated signed-in session.
    },
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
}
