import type { Session } from '@supabase/supabase-js';

import { ApiTransportError } from '@/api/client';
import type { ApiRequestOptions } from '@/api/client';

import type { EmailLinkPkce } from './email-link-pkce';
import type { PendingEmailLinkStore } from './email-link-pending';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

type EmailLinkAuthGateway = {
  getSession(): Promise<{
    data: { session: Session | null };
    error: unknown | null;
  }>;
};

type EmailLinkApiGateway = (
  path: string,
  options?: ApiRequestOptions,
) => Promise<unknown>;

export type EmailLinkStartDependencies = {
  auth: EmailLinkAuthGateway;
  api: EmailLinkApiGateway;
  pending: PendingEmailLinkStore;
  createPkce: () => Promise<EmailLinkPkce>;
  now?: () => number;
};

export class EmailLinkStartError extends Error {
  readonly reason: 'INVALID_EMAIL' | 'NOT_ANONYMOUS' | 'SESSION_UNAVAILABLE';

  constructor(reason: EmailLinkStartError['reason']) {
    super(`Email link request failed with ${reason}.`);
    this.name = 'EmailLinkStartError';
    this.reason = reason;
  }
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export async function startEmailLink(
  email: string,
  dependencies: EmailLinkStartDependencies,
): Promise<void> {
  const normalizedEmail = normalizeEmail(email);
  if (
    normalizedEmail.length < 3
    || normalizedEmail.length > 254
    || !EMAIL_PATTERN.test(normalizedEmail)
  ) {
    throw new EmailLinkStartError('INVALID_EMAIL');
  }

  const sessionResult = await dependencies.auth.getSession();
  const session = sessionResult.data.session;
  if (sessionResult.error !== null || session === null) {
    throw new EmailLinkStartError('SESSION_UNAVAILABLE');
  }
  if (session.user.is_anonymous !== true) {
    throw new EmailLinkStartError('NOT_ANONYMOUS');
  }

  const pkce = await dependencies.createPkce();
  await dependencies.pending.save({
    flowId: pkce.flowId,
    verifier: pkce.verifier,
    authUserId: session.user.id.toLowerCase(),
    createdAt: (dependencies.now ?? Date.now)(),
  });

  try {
    await dependencies.api('/api/auth/link-email', {
      method: 'POST',
      authenticated: true,
      json: {
        email: normalizedEmail,
        flow_id: pkce.flowId,
        code_challenge: pkce.challenge,
        code_challenge_method: 's256',
      },
    });
  } catch (error) {
    if (
      !(error instanceof ApiTransportError)
      || error.failure === 'AUTH_SESSION_UNAVAILABLE'
    ) {
      await dependencies.pending.clear(pkce.flowId);
    }
    throw error;
  }
}
