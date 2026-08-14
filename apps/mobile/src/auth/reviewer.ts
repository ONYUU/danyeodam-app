import type { Session } from '@supabase/supabase-js';

export type ReviewerAccess = {
  participant: true;
  access_type: 'store_reviewer';
  field_acquisition_requires_location: true;
  fixture_version: string;
};

export type ReviewerProbeAuthGateway = {
  signInWithPassword(input: {
    email: string;
    password: string;
  }): Promise<{
    data: { session: Session | null };
    error: unknown | null;
  }>;
  signOut(options: { scope: 'local' }): Promise<{ error: unknown | null }>;
};

export type ReviewerPrimaryAuthGateway = {
  setSession(input: {
    access_token: string;
    refresh_token: string;
  }): Promise<{ error: unknown | null }>;
};

type ReviewerDependencies = {
  probeAuth: ReviewerProbeAuthGateway;
  primaryAuth: ReviewerPrimaryAuthGateway;
  fetch: typeof fetch;
};

const REQUEST_TIMEOUT_MS = 10_000;

function isReviewerAccess(value: unknown): value is ReviewerAccess {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<ReviewerAccess>;
  return candidate.participant === true
    && candidate.access_type === 'store_reviewer'
    && candidate.field_acquisition_requires_location === true
    && typeof candidate.fixture_version === 'string'
    && candidate.fixture_version.length >= 1
    && candidate.fixture_version.length <= 64;
}

async function removeProbeSession(auth: ReviewerProbeAuthGateway): Promise<void> {
  const result = await auth.signOut({ scope: 'local' });
  if (result.error !== null) {
    throw new Error('REVIEWER_SESSION_REMOVAL_FAILED');
  }
}

export async function signInStoreReviewer(
  input: {
    email: string;
    password: string;
    apiBaseUrl: string;
  },
  dependencies: ReviewerDependencies,
): Promise<ReviewerAccess> {
  const signedIn = await dependencies.probeAuth.signInWithPassword({
    email: input.email.trim(),
    password: input.password,
  });
  if (signedIn.error !== null || signedIn.data.session === null) {
    throw new Error('REVIEWER_CREDENTIALS_INVALID');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const endpoint = new URL('/api/me/access', `${input.apiBaseUrl.replace(/\/$/u, '')}/`);
    const response = await dependencies.fetch(endpoint, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${signedIn.data.session.access_token}`,
      },
      signal: controller.signal,
    });
    const payload: unknown = response.ok
      ? await response.json().catch(() => null)
      : null;
    if (!response.ok || !isReviewerAccess(payload)) {
      await removeProbeSession(dependencies.probeAuth);
      throw new Error('REVIEWER_ACCESS_DENIED');
    }
    const adopted = await dependencies.primaryAuth.setSession({
      access_token: signedIn.data.session.access_token,
      refresh_token: signedIn.data.session.refresh_token,
    });
    if (adopted.error !== null) {
      await removeProbeSession(dependencies.probeAuth);
      throw new Error('REVIEWER_SESSION_ADOPTION_FAILED');
    }
    return payload;
  } catch (error) {
    if (error instanceof Error && (
      error.message === 'REVIEWER_ACCESS_DENIED'
      || error.message === 'REVIEWER_SESSION_ADOPTION_FAILED'
      || error.message === 'REVIEWER_SESSION_REMOVAL_FAILED'
    )) {
      throw error;
    }
    await removeProbeSession(dependencies.probeAuth);
    throw new Error('REVIEWER_ACCESS_CHECK_FAILED');
  } finally {
    clearTimeout(timeout);
  }
}
