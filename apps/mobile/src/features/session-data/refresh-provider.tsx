import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';

import { useAuth } from '@/auth/auth-provider';
import {
  createSessionBindingGenerationController,
  type SessionBindingGeneration,
} from './generation';

type RefreshContextValue = {
  accessVersion: number;
  collectionVersion: number;
  generation: SessionBindingGeneration;
  isGenerationCurrent(generation: SessionBindingGeneration): boolean;
  refreshAccess(): void;
  refreshCollection(): void;
  refreshAccessAndCollection(): void;
};

const RefreshContext = createContext<RefreshContextValue | null>(null);

export function SessionDataRefreshProvider({ children }: PropsWithChildren) {
  const auth = useAuth();
  const authIdentity = auth.status === 'ready'
    ? `${auth.session?.user.id ?? 'missing'}:${auth.session?.user.is_anonymous === true}`
    : auth.status;

  return (
    <SessionDataRefreshProviderForIdentity key={authIdentity}>
      {children}
    </SessionDataRefreshProviderForIdentity>
  );
}

function SessionDataRefreshProviderForIdentity({ children }: PropsWithChildren) {
  const [accessVersion, setAccessVersion] = useState(0);
  const [collectionVersion, setCollectionVersion] = useState(0);
  const [generationController] = useState(
    createSessionBindingGenerationController,
  );
  const [generation, setGeneration] = useState(
    generationController.current,
  );

  const rotateBindingGeneration = useCallback(() => {
    setGeneration(generationController.rotateBinding());
  }, [generationController]);

  const refreshAccess = useCallback(() => {
    rotateBindingGeneration();
    setAccessVersion((current) => current + 1);
  }, [rotateBindingGeneration]);
  const refreshCollection = useCallback(() => {
    setCollectionVersion((current) => current + 1);
  }, []);
  const refreshAccessAndCollection = useCallback(() => {
    rotateBindingGeneration();
    setAccessVersion((current) => current + 1);
    setCollectionVersion((current) => current + 1);
  }, [rotateBindingGeneration]);
  const isGenerationCurrent = useCallback(
    (candidate: SessionBindingGeneration) => generationController.isCurrent(candidate),
    [generationController],
  );

  const value = useMemo<RefreshContextValue>(() => ({
    accessVersion,
    collectionVersion,
    generation,
    isGenerationCurrent,
    refreshAccess,
    refreshCollection,
    refreshAccessAndCollection,
  }), [
    accessVersion,
    collectionVersion,
    generation,
    isGenerationCurrent,
    refreshAccess,
    refreshAccessAndCollection,
    refreshCollection,
  ]);

  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>;
}

export function useSessionDataRefresh(): RefreshContextValue {
  const value = useContext(RefreshContext);
  if (value === null) {
    throw new Error('useSessionDataRefresh must be used within SessionDataRefreshProvider.');
  }
  return value;
}
