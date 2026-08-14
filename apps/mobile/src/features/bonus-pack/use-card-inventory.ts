import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  mergeInventoryItems,
  type InventoryItem,
} from '@/api/card-inventory';
import { getCardInventoryPage } from '@/api/card-inventory-client';
import { useSessionDataRefresh } from '@/features/session-data/refresh-provider';
import type { SupportedLocale } from '@/i18n/locales';

export type InventoryLoadState =
  | Readonly<{ status: 'idle' }>
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'error'; error: unknown }>
  | Readonly<{
      status: 'ready';
      items: readonly InventoryItem[];
      nextCursor: string | null;
      hasMore: boolean;
      loadingMore: boolean;
      loadMoreError: unknown | null;
    }>;

export function useCardInventory(input: {
  locale: SupportedLocale;
  enabled: boolean;
  sessionKey: string | null;
}) {
  const { collectionVersion } = useSessionDataRefresh();
  const [attempt, setAttempt] = useState(0);
  const requestKey = input.enabled && input.sessionKey !== null
    ? `${input.sessionKey}:${input.locale}:${collectionVersion}:${attempt}`
    : null;
  const [result, setResult] = useState<{
    requestKey: string;
    state: InventoryLoadState;
  } | null>(null);
  const state = useMemo<InventoryLoadState>(() => {
    if (requestKey === null) return { status: 'idle' };
    return result?.requestKey === requestKey
      ? result.state
      : { status: 'loading' };
  }, [requestKey, result]);
  const generation = useRef(0);
  const paginationController = useRef<AbortController | null>(null);

  useEffect(() => {
    generation.current += 1;
    const currentGeneration = generation.current;
    paginationController.current?.abort();
    paginationController.current = null;
    if (requestKey === null) return undefined;
    const controller = new AbortController();
    void getCardInventoryPage({
      locale: input.locale,
      signal: controller.signal,
    }).then((page) => {
      if (!controller.signal.aborted && generation.current === currentGeneration) {
        setResult({
          requestKey,
          state: {
            status: 'ready',
            items: page.items,
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
            loadingMore: false,
            loadMoreError: null,
          },
        });
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && generation.current === currentGeneration) {
        setResult({ requestKey, state: { status: 'error', error } });
      }
    });
    return () => controller.abort();
  }, [input.locale, requestKey]);

  useEffect(() => () => paginationController.current?.abort(), []);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  const loadMore = useCallback(() => {
    if (state.status !== 'ready' || state.loadingMore || !state.hasMore) return;
    const cursor = state.nextCursor;
    if (cursor === null) return;
    const currentGeneration = generation.current;
    const controller = new AbortController();
    paginationController.current?.abort();
    paginationController.current = controller;
    setResult((current) => current?.requestKey === requestKey
      && current.state.status === 'ready'
      ? {
          requestKey,
          state: { ...current.state, loadingMore: true, loadMoreError: null },
        }
      : current);
    void getCardInventoryPage({
      locale: input.locale,
      cursor,
      signal: controller.signal,
    }).then((page) => {
      if (controller.signal.aborted || generation.current !== currentGeneration) return;
      setResult((current) => current?.requestKey === requestKey
        && current.state.status === 'ready'
        ? {
            requestKey,
            state: {
              ...current.state,
              items: mergeInventoryItems(current.state.items, page.items),
              nextCursor: page.nextCursor,
              hasMore: page.hasMore,
              loadingMore: false,
              loadMoreError: null,
            },
          }
        : current);
    }).catch((error: unknown) => {
      if (controller.signal.aborted || generation.current !== currentGeneration) return;
      setResult((current) => current?.requestKey === requestKey
        && current.state.status === 'ready'
        ? {
            requestKey,
            state: { ...current.state, loadingMore: false, loadMoreError: error },
          }
        : current);
    });
  }, [input.locale, requestKey, state]);

  return { state, retry, loadMore };
}
