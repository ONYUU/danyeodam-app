import type { Session } from '@supabase/supabase-js';

type AuthResult = {
  data: { session: Session | null };
  error: unknown | null;
};

export type SessionAuthGateway = {
  getSession(): Promise<AuthResult>;
  signInAnonymously(): Promise<AuthResult>;
  signOut(options: { scope: 'local' }): Promise<{ error: unknown | null }>;
};

export async function restoreOrCreateAnonymousSession(
  auth: SessionAuthGateway,
): Promise<Session> {
  const restored = await auth.getSession();
  if (restored.error !== null) {
    throw new Error('AUTH_SESSION_RESTORE_FAILED');
  }
  if (restored.data.session !== null) {
    return restored.data.session;
  }

  const created = await auth.signInAnonymously();
  if (created.error !== null || created.data.session === null) {
    throw new Error('AUTH_ANONYMOUS_SIGN_IN_FAILED');
  }
  return created.data.session;
}

export async function removeLocalSession(auth: SessionAuthGateway): Promise<void> {
  const result = await auth.signOut({ scope: 'local' });
  if (result.error !== null) {
    throw new Error('AUTH_LOCAL_SIGN_OUT_FAILED');
  }
}
