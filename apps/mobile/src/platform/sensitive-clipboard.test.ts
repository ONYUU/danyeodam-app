import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RECOVERY_CLIPBOARD_CLEAR_MS,
  scheduleClearIfClipboardUnchanged,
} from './sensitive-clipboard';

afterEach(() => {
  vi.useRealTimers();
});

describe('sensitive clipboard expiry', () => {
  it('clears the recovery code after one minute only when it is unchanged', async () => {
    vi.useFakeTimers();
    const setString = vi.fn(async () => true);
    scheduleClearIfClipboardUnchanged('recovery-secret', {
      getString: async () => 'recovery-secret',
      setString,
    }, RECOVERY_CLIPBOARD_CLEAR_MS);

    await vi.advanceTimersByTimeAsync(RECOVERY_CLIPBOARD_CLEAR_MS);

    expect(setString).toHaveBeenCalledWith('');
  });

  it('does not erase clipboard content the user replaced', async () => {
    vi.useFakeTimers();
    const setString = vi.fn(async () => true);
    scheduleClearIfClipboardUnchanged('recovery-secret', {
      getString: async () => 'new-user-content',
      setString,
    }, RECOVERY_CLIPBOARD_CLEAR_MS);

    await vi.advanceTimersByTimeAsync(RECOVERY_CLIPBOARD_CLEAR_MS);

    expect(setString).not.toHaveBeenCalled();
  });
});
