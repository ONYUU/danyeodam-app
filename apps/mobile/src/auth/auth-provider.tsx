import type { Session } from '@supabase/supabase-js';
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { removeLocalSession, restoreOrCreateAnonymousSession } from './session';
import { supabase } from './supabase';

export type AuthStatus = 'loading' | 'ready' | 'signed_out' | 'error';

type AuthContextValue = {
  session: Session | null;
  status: AuthStatus;
  retry(): void;
  removeSession(): Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  }, []);

  const removeSession = useCallback(async () => {
    await removeLocalSession(supabase.auth);
    setSession(null);
    setStatus('signed_out');
  }, []);

  useEffect(() => {
    let mounted = true;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) {
        return;
      }
      setSession(nextSession);
      setStatus(nextSession === null ? 'signed_out' : 'ready');
    });

    void restoreOrCreateAnonymousSession(supabase.auth)
      .then((nextSession) => {
        if (mounted) {
          setSession(nextSession);
          setStatus('ready');
        }
      })
      .catch(() => {
        if (mounted) {
          setSession(null);
          setStatus('error');
        }
      });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [attempt]);

  useEffect(() => {
    const updateRefreshState = (nextState: AppStateStatus) => {
      if (nextState === 'active') {
        supabase.auth.startAutoRefresh();
      } else {
        supabase.auth.stopAutoRefresh();
      }
    };
    updateRefreshState(AppState.currentState);
    const subscription = AppState.addEventListener('change', updateRefreshState);
    return () => {
      subscription.remove();
      supabase.auth.stopAutoRefresh();
    };
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    session,
    status,
    retry,
    removeSession,
  }), [removeSession, retry, session, status]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error('useAuth must be used within AuthProvider.');
  }
  return value;
}
