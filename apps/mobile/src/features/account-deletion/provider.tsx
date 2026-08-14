import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { getPublicAccountDeletionStatus } from '@/api/account-deletion-status-client';
import { pendingEmailLinkStore } from '@/auth/email-link-storage';
import { minimumAgeDevicePassStore } from '@/features/minimum-age/device-pass-storage';

import { accountDeletionCredentialStore } from './credential-storage';
import { generateNativeAccountDeletionCredential } from './credential-generation-native';
import type { StoredAccountDeletionCredential } from './credential';
import {
  reconcileAccountDeletion,
  type AccountDeletionLifecycleResult,
} from './lifecycle';

type InternalState =
  | { phase: 'checking'; loadAttempt: number }
  | { phase: 'load_error'; loadAttempt: number }
  | { phase: 'inactive' }
  | {
      phase: 'active';
      credential: StoredAccountDeletionCredential;
      result: AccountDeletionLifecycleResult | null;
      failed: boolean;
      attempt: number;
    };

export type AccountDeletionGateState =
  | { status: 'checking' }
  | { status: 'inactive' }
  | { status: 'reconciling' }
  | { status: 'error' }
  | AccountDeletionLifecycleResult;

type AccountDeletionContextValue = {
  state: AccountDeletionGateState;
  begin(): Promise<void>;
  retry(): void;
  restartAfterAuthorizationFailure(): Promise<void>;
  finishCompletedDeletion(): Promise<void>;
};

const AccountDeletionContext = createContext<AccountDeletionContextValue | null>(null);

async function requestWithExistingSession(
  credential: StoredAccountDeletionCredential,
) {
  const { requestAccountDeletion } = await import('@/api/account-deletion-client');
  return requestAccountDeletion(credential);
}

async function removeExistingLocalSession(): Promise<void> {
  const [{ removeLocalSession }, { supabase }] = await Promise.all([
    import('@/auth/session'),
    import('@/auth/supabase'),
  ]);
  await removeLocalSession(supabase.auth);
}

export function AccountDeletionProvider({ children }: PropsWithChildren) {
  const [internal, setInternal] = useState<InternalState>({
    phase: 'checking',
    loadAttempt: 0,
  });
  const beginInFlight = useRef(false);
  const finishInFlight = useRef(false);

  useEffect(() => {
    if (internal.phase !== 'checking') return;
    let active = true;
    void accountDeletionCredentialStore.load()
      .then((credential) => {
        if (!active) return;
        setInternal(credential === null
          ? { phase: 'inactive' }
          : {
              phase: 'active',
              credential,
              result: null,
              failed: false,
              attempt: 0,
            });
      })
      .catch(() => {
        if (active) {
          setInternal((current) => ({
            phase: 'load_error',
            loadAttempt: current.phase === 'checking'
              ? current.loadAttempt
              : 0,
          }));
        }
      });
    return () => {
      active = false;
    };
  }, [internal]);

  useEffect(() => {
    if (
      internal.phase !== 'active'
      || internal.result !== null
      || internal.failed
    ) return;
    let active = true;
    const credential = {
      requestId: internal.credential.requestId,
      statusToken: internal.credential.statusToken,
    };
    void reconcileAccountDeletion(credential, {
      getStatus: getPublicAccountDeletionStatus,
      request: requestWithExistingSession,
      removeLocalSession: removeExistingLocalSession,
    }).then((result) => {
      if (!active) return;
      setInternal((current) => current.phase === 'active'
        && current.credential.requestId === credential.requestId
        ? { ...current, result, failed: false }
        : current);
    }).catch(() => {
      if (!active) return;
      setInternal((current) => current.phase === 'active'
        && current.credential.requestId === credential.requestId
        ? { ...current, failed: true }
        : current);
    });
    return () => {
      active = false;
    };
  }, [internal]);

  const begin = useCallback(async () => {
    if (beginInFlight.current) return;
    beginInFlight.current = true;
    try {
      const credential = await generateNativeAccountDeletionCredential();
      await accountDeletionCredentialStore.save(credential);
      setInternal({
        phase: 'active',
        credential,
        result: null,
        failed: false,
        attempt: 0,
      });
    } finally {
      beginInFlight.current = false;
    }
  }, []);

  const retry = useCallback(() => {
    setInternal((current) => {
      if (current.phase === 'checking') {
        return current;
      }
      if (current.phase === 'load_error') {
        return { phase: 'checking', loadAttempt: current.loadAttempt + 1 };
      }
      if (current.phase !== 'active') return current;
      return {
        ...current,
        result: null,
        failed: false,
        attempt: current.attempt + 1,
      };
    });
  }, []);

  const restartAfterAuthorizationFailure = useCallback(async () => {
    const current = internal;
    if (
      current.phase !== 'active'
      || current.result?.status !== 'authorization_required'
    ) return;
    await removeExistingLocalSession();
    await pendingEmailLinkStore.clear();
    await minimumAgeDevicePassStore.clear();
    await accountDeletionCredentialStore.clear(current.credential.requestId);
    setInternal({ phase: 'inactive' });
  }, [internal]);

  const finishCompletedDeletion = useCallback(async () => {
    if (finishInFlight.current) return;
    const current = internal;
    if (
      current.phase !== 'active'
      || current.result?.status !== 'completed'
    ) return;
    finishInFlight.current = true;
    try {
      await removeExistingLocalSession();
      await pendingEmailLinkStore.clear();
      await minimumAgeDevicePassStore.clear();
      await accountDeletionCredentialStore.clear(current.credential.requestId);
      setInternal({ phase: 'inactive' });
    } finally {
      finishInFlight.current = false;
    }
  }, [internal]);

  const state = useMemo<AccountDeletionGateState>(() => (
    internal.phase === 'checking'
      ? { status: 'checking' }
      : internal.phase === 'load_error'
        ? { status: 'error' }
        : internal.phase === 'inactive'
          ? { status: 'inactive' }
          : internal.failed
            ? { status: 'error' }
            : internal.result ?? { status: 'reconciling' }
  ), [internal]);

  const value = useMemo<AccountDeletionContextValue>(() => ({
    state,
    begin,
    retry,
    restartAfterAuthorizationFailure,
    finishCompletedDeletion,
  }), [begin, finishCompletedDeletion, restartAfterAuthorizationFailure, retry, state]);

  return (
    <AccountDeletionContext.Provider value={value}>
      {children}
    </AccountDeletionContext.Provider>
  );
}

export function useAccountDeletion(): AccountDeletionContextValue {
  const value = useContext(AccountDeletionContext);
  if (value === null) {
    throw new Error('useAccountDeletion must be used within AccountDeletionProvider.');
  }
  return value;
}
