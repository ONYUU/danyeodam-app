import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { UserBlock } from '@/api/blocks';
import { getUserBlocksPage } from '@/api/blocks-client';
import { mergeUserBlocks } from './page-merge';

export type UserBlocksLoadState =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'error'; error: unknown }>
  | Readonly<{
      status: 'ready';
      items: readonly UserBlock[];
      nextCursor: string | null;
      loadingMore: boolean;
      loadMoreError: unknown | null;
    }>;

export function useUserBlocks(sessionKey: string) {
  const [attempt, setAttempt] = useState(0);
  const requestKey = `${sessionKey}:${attempt}`;
  const [result, setResult] = useState<{
    requestKey: string;
    state: UserBlocksLoadState;
  } | null>(null);
  const paginationController = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const state = useMemo<UserBlocksLoadState>(() => (
    result?.requestKey === requestKey
      ? result.state
      : { status: 'loading' }
  ), [requestKey, result]);

  useEffect(() => {
    generation.current += 1;
    const currentGeneration = generation.current;
    paginationController.current?.abort();
    paginationController.current = null;
    const controller = new AbortController();
    void getUserBlocksPage({ signal: controller.signal })
      .then((page) => {
        if (!controller.signal.aborted && generation.current === currentGeneration) {
          setResult({
            requestKey,
            state: {
              status: 'ready',
              items: page.items,
              nextCursor: page.nextCursor,
              loadingMore: false,
              loadMoreError: null,
            },
          });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && generation.current === currentGeneration) {
          setResult({ requestKey, state: { status: 'error', error } });
        }
      });
    return () => controller.abort();
  }, [requestKey]);

  useEffect(() => () => paginationController.current?.abort(), []);

  const refresh = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  const remove = useCallback((blockId: string) => {
    setResult((current) => current?.requestKey === requestKey
      && current.state.status === 'ready'
      ? {
          requestKey,
          state: {
            ...current.state,
            items: current.state.items.filter(({ id }) => id !== blockId),
          },
        }
      : current);
  }, [requestKey]);

  const loadMore = useCallback(() => {
    if (
      state.status !== 'ready'
      || state.loadingMore
      || state.nextCursor === null
    ) {
      return;
    }
    const cursor = state.nextCursor;
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
    void getUserBlocksPage({ cursor, signal: controller.signal })
      .then((page) => {
        if (controller.signal.aborted || generation.current !== currentGeneration) return;
        setResult((current) => current?.requestKey === requestKey
          && current.state.status === 'ready'
          ? mergePageResult(requestKey, current.state, page)
          : current);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || generation.current !== currentGeneration) return;
        setResult((current) => current?.requestKey === requestKey
          && current.state.status === 'ready'
          ? {
              requestKey,
              state: { ...current.state, loadingMore: false, loadMoreError: error },
            }
          : current);
      });
  }, [requestKey, state]);

  return { state, refresh, loadMore, remove };
}

function mergePageResult(
  requestKey: string,
  current: Extract<UserBlocksLoadState, { status: 'ready' }>,
  page: Awaited<ReturnType<typeof getUserBlocksPage>>,
) {
  try {
    return {
      requestKey,
      state: {
        ...current,
        items: mergeUserBlocks(current.items, page.items),
        nextCursor: page.nextCursor,
        loadingMore: false,
        loadMoreError: null,
      } satisfies UserBlocksLoadState,
    };
  } catch (error) {
    return {
      requestKey,
      state: {
        ...current,
        loadingMore: false,
        loadMoreError: error,
      } satisfies UserBlocksLoadState,
    };
  }
}
