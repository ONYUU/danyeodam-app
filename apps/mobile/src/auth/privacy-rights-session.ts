import type { Session } from '@supabase/supabase-js';

export type ExistingSessionAuthGateway = {
  getSession(): Promise<{
    data: { session: Session | null };
    error: unknown | null;
  }>;
};

export async function restoreExistingPrivacyRightsSession(
  auth: ExistingSessionAuthGateway,
): Promise<Session | null> {
  const restored = await auth.getSession();
  if (restored.error !== null) {
    throw new Error('PRIVACY_RIGHTS_SESSION_RESTORE_FAILED');
  }
  return restored.data.session;
}
