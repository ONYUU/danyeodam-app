import { useCallback, useEffect, useRef, useState } from 'react';

import { DEFAULT_REVEAL_HAPTICS_ENABLED } from './haptic-preference';
import { hapticPreferenceStorage } from './haptic-preference-storage';

export type HapticPreferenceState = Readonly<{
  enabled: boolean;
  loading: boolean;
  saving: boolean;
  error: boolean;
}>;

export function useHapticPreference() {
  const [state, setState] = useState<HapticPreferenceState>({
    enabled: DEFAULT_REVEAL_HAPTICS_ENABLED,
    loading: true,
    saving: false,
    error: false,
  });
  const operation = useRef(0);

  useEffect(() => {
    const currentOperation = operation.current;
    let mounted = true;
    void hapticPreferenceStorage.load().then((enabled) => {
      if (mounted && operation.current === currentOperation) {
        setState({ enabled, loading: false, saving: false, error: false });
      }
    }).catch(() => {
      if (mounted && operation.current === currentOperation) {
        setState((current) => ({ ...current, loading: false, error: true }));
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  const setEnabled = useCallback((enabled: boolean) => {
    operation.current += 1;
    const currentOperation = operation.current;
    setState({ enabled, loading: false, saving: true, error: false });
    void hapticPreferenceStorage.save(enabled).then(() => {
      if (operation.current === currentOperation) {
        setState({ enabled, loading: false, saving: false, error: false });
      }
    }).catch(() => {
      if (operation.current === currentOperation) {
        setState({
          enabled: !enabled,
          loading: false,
          saving: false,
          error: true,
        });
      }
    });
  }, []);

  return { state, setEnabled };
}
