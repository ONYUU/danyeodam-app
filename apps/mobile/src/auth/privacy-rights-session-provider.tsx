import {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { supabase } from './supabase';
import { restoreExistingPrivacyRightsSession } from './privacy-rights-session';

export type PrivacyRightsSessionCapability = Readonly<{
  userId: string;
}>;

export type PrivacyRightsSessionStatus =
  | 'checking'
  | 'ready'
  | 'no_session'
  | 'error';

type PrivacyRightsSessionContextValue = {
  capability: PrivacyRightsSessionCapability | null;
  status: PrivacyRightsSessionStatus;
  retry(): void;
};

const PrivacyRightsSessionContext =
  createContext<PrivacyRightsSessionContextValue | null>(null);

export function PrivacyRightsSessionProvider({ children }: PropsWithChildren) {
  const [capability, setCapability] =
    useState<PrivacyRightsSessionCapability | null>(null);
  const [status, setStatus] = useState<PrivacyRightsSessionStatus>('checking');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void restoreExistingPrivacyRightsSession(supabase.auth)
      .then((session) => {
        if (!active) {
          return;
        }
        if (session === null) {
          setCapability(null);
          setStatus('no_session');
          return;
        }
        setCapability({
          userId: session.user.id,
        });
        setStatus('ready');
      })
      .catch(() => {
        if (active) {
          setCapability(null);
          setStatus('error');
        }
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  const value = useMemo<PrivacyRightsSessionContextValue>(() => ({
    capability,
    status,
    retry() {
      setCapability(null);
      setStatus('checking');
      setAttempt((current) => current + 1);
    },
  }), [capability, status]);

  return (
    <PrivacyRightsSessionContext.Provider value={value}>
      {children}
    </PrivacyRightsSessionContext.Provider>
  );
}

export function usePrivacyRightsSession(): PrivacyRightsSessionContextValue {
  const value = useContext(PrivacyRightsSessionContext);
  if (value === null) {
    throw new Error(
      'usePrivacyRightsSession must be used within PrivacyRightsSessionProvider.',
    );
  }
  return value;
}
