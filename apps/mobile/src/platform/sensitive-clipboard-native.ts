import * as Clipboard from 'expo-clipboard';

import {
  RECOVERY_CLIPBOARD_CLEAR_MS,
  scheduleClearIfClipboardUnchanged,
} from './sensitive-clipboard';

export function scheduleRecoveryClipboardClear(sensitiveValue: string): void {
  scheduleClearIfClipboardUnchanged(
    sensitiveValue,
    {
      getString: () => Clipboard.getStringAsync(),
      setString: (value) => Clipboard.setStringAsync(value),
    },
    RECOVERY_CLIPBOARD_CLEAR_MS,
  );
}
