import * as Linking from 'expo-linking';
import { usePathname, useRouter } from 'expo-router';
import {
  type PropsWithChildren,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import {
  isShareBlockIngressCandidate,
  sanitizedShareBlockRouteFor,
  stageShareBlockIngress,
} from './secret-ingress';

type IngressPhase = 'checking' | 'redirecting' | 'ready';

export function PublicShareBlockIngressBoundary({ children }: PropsWithChildren) {
  const router = useRouter();
  const pathname = usePathname();
  const [phase, setPhase] = useState<IngressPhase>('checking');
  const pathnameRef = useRef(pathname);
  const initialSettledRef = useRef(false);
  const liveCandidateDuringInitialReadRef = useRef(false);

  useLayoutEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  const consumeCandidate = useCallback((url: string, bounceCurrent: boolean): boolean => {
    if (!isShareBlockIngressCandidate(url)) return false;
    stageShareBlockIngress(url);
    setPhase('redirecting');
    router.replace(sanitizedShareBlockRouteFor(
      bounceCurrent ? '/public-share-block' : pathnameRef.current,
    ));
    return true;
  }, [router]);

  useLayoutEffect(() => {
    let active = true;

    void Linking.getInitialURL().then((url) => {
      if (!active) return;
      initialSettledRef.current = true;
      if (liveCandidateDuringInitialReadRef.current) return;
      if (url === null || !consumeCandidate(url, false)) setPhase('ready');
    }).catch(() => {
      if (!active) return;
      initialSettledRef.current = true;
      if (!liveCandidateDuringInitialReadRef.current) setPhase('ready');
    });

    return () => {
      active = false;
    };
  }, [consumeCandidate]);

  useLayoutEffect(() => {
    const liveSubscription = Linking.addEventListener('url', ({ url }) => {
      if (!isShareBlockIngressCandidate(url)) return;
      if (!initialSettledRef.current) {
        liveCandidateDuringInitialReadRef.current = true;
      }
      consumeCandidate(url, pathnameRef.current === '/public-share-block');
    });
    return () => liveSubscription.remove();
  }, [consumeCandidate]);

  return phase === 'ready' || phase === 'redirecting' ? children : null;
}
