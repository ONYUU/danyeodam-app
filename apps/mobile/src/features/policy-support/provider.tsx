import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';

import type { PolicyType } from '@/api/policies';

export type PolicySupportRequest = {
  focus: 'hub' | PolicyType;
  id: number;
};

type PolicySupportContextValue = {
  close(): void;
  openHub(): void;
  openPolicy(type: PolicyType): void;
  openPrivacyPolicy(): void;
  request: PolicySupportRequest | null;
};

const PolicySupportContext = createContext<PolicySupportContextValue | null>(null);

export function PolicySupportProvider({ children }: PropsWithChildren) {
  const [request, setRequest] = useState<PolicySupportRequest | null>(null);
  const close = useCallback(() => setRequest(null), []);
  const open = useCallback((focus: PolicySupportRequest['focus']) => {
    setRequest((current) => ({ focus, id: (current?.id ?? 0) + 1 }));
  }, []);
  const value = useMemo<PolicySupportContextValue>(() => ({
    close,
    openHub: () => open('hub'),
    openPolicy: (type) => open(type),
    openPrivacyPolicy: () => open('privacy_policy'),
    request,
  }), [close, open, request]);

  return (
    <PolicySupportContext.Provider value={value}>
      {children}
    </PolicySupportContext.Provider>
  );
}

export function usePolicySupport(): PolicySupportContextValue {
  const value = useContext(PolicySupportContext);
  if (value === null) {
    throw new Error('usePolicySupport must be used within PolicySupportProvider.');
  }
  return value;
}
