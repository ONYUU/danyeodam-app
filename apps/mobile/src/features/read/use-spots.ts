import { useCallback, useEffect, useState } from 'react';

import { listSpots } from '@/api/spots-client';
import type { SpotsSnapshot } from '@/api/spots';
import type { SupportedLocale } from '@/i18n/locales';

export type SpotsLoadState =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: SpotsSnapshot }
  | { status: 'error'; error: unknown };

export function useSpots(locale: SupportedLocale) {
  const [attempt, setAttempt] = useState(0);
  const requestKey = `${locale}:${attempt}`;
  const [result, setResult] = useState<{
    requestKey: string;
    state: SpotsLoadState;
  } | null>(null);
  const state: SpotsLoadState = result?.requestKey === requestKey
    ? result.state
    : { status: 'loading' };

  useEffect(() => {
    const controller = new AbortController();
    void listSpots(locale, controller.signal)
      .then((snapshot) => {
        if (!controller.signal.aborted) {
          setResult({ requestKey, state: { status: 'ready', snapshot } });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setResult({ requestKey, state: { status: 'error', error } });
        }
      });
    return () => controller.abort();
  }, [locale, requestKey]);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  return { state, retry };
}
