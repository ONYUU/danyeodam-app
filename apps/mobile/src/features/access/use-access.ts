import { useCallback, useEffect, useMemo, useState } from 'react';

import { getAccess } from '@/api/access-client';
import type { AccessProjection } from '@/api/access';
import { useAuth } from '@/auth/auth-provider';
import { useSessionDataRefresh } from '@/features/session-data/refresh-provider';

export type AccessLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; access: AccessProjection }
  | { status: 'error'; error: unknown };

export function useAccess() {
  const auth = useAuth();
  const { accessVersion, refreshAccess } = useSessionDataRefresh();
  const sessionKey = auth.status === 'ready' ? auth.session?.user.id ?? null : null;
  const requestKey = sessionKey === null
    ? null
    : `${sessionKey}:${accessVersion}`;
  const [result, setResult] = useState<{
    requestKey: string;
    state: AccessLoadState;
  } | null>(null);
  const state = useMemo<AccessLoadState>(() => {
    if (requestKey === null) {
      return { status: 'idle' };
    }
    return result?.requestKey === requestKey
      ? result.state
      : { status: 'loading' };
  }, [requestKey, result]);

  useEffect(() => {
    if (requestKey === null) {
      return undefined;
    }
    const controller = new AbortController();
    void getAccess(controller.signal).then((access) => {
      if (!controller.signal.aborted) {
        setResult({ requestKey, state: { status: 'ready', access } });
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setResult({ requestKey, state: { status: 'error', error } });
      }
    });
    return () => controller.abort();
  }, [requestKey]);

  const retry = useCallback(() => {
    refreshAccess();
  }, [refreshAccess]);

  return { state, retry };
}
