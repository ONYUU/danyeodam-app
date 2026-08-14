import { useCallback, useEffect, useMemo, useState } from 'react';

import { loadOwnedPersonalCardPhoto } from '@/api/personal-card-photo-client';

import { createOwnedPhotoLoadAttempt } from './owned-photo-attempt';

type OwnedPhotoState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; blob: Blob; objectUrl: string }
  | { status: 'error'; error: unknown };

export function useOwnedPersonalCardPhoto(input: {
  enabled: boolean;
  personalCardId: string;
  photoPath: string;
  sessionVersion: number;
}) {
  const [attempt, setAttempt] = useState(0);
  const requestKey = input.enabled
    ? `${input.personalCardId}:${input.photoPath}:${input.sessionVersion}:${attempt}`
    : null;
  const [result, setResult] = useState<{
    requestKey: string;
    state: OwnedPhotoState;
  } | null>(null);
  const state = useMemo<OwnedPhotoState>(() => {
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
    const attempt = createOwnedPhotoLoadAttempt();
    void loadOwnedPersonalCardPhoto({
      personalCardId: input.personalCardId,
      photoPath: input.photoPath,
      signal: attempt.signal,
    }).then((blob) => {
      const resource = attempt.publish(blob);
      if (resource === null) {
        return;
      }
      setResult({
        requestKey,
        state: { status: 'ready', ...resource },
      });
    }).catch((error: unknown) => {
      if (!attempt.signal.aborted) {
        setResult({ requestKey, state: { status: 'error', error } });
      }
    });
    return () => attempt.release();
  }, [input.personalCardId, input.photoPath, requestKey]);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  return { state, retry };
}
