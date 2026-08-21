import { describe, expect, it, vi } from 'vitest';

import {
  createHapticPreferenceStorage,
  parseStoredHapticPreference,
} from './haptic-preference';

describe('bonus pack reveal haptic preference', () => {
  it('defaults on but accepts only the two stored values', () => {
    expect(parseStoredHapticPreference(null)).toBe(true);
    expect(parseStoredHapticPreference('enabled')).toBe(true);
    expect(parseStoredHapticPreference('disabled')).toBe(false);
    expect(parseStoredHapticPreference('true')).toBe(true);
  });

  it('stores no user or pack data with the local preference', async () => {
    const backend = {
      getItem: vi.fn(async () => 'disabled'),
      setItem: vi.fn(async () => undefined),
    };
    const storage = createHapticPreferenceStorage(backend);
    await expect(storage.load()).resolves.toBe(false);
    await storage.save(true);
    expect(backend.setItem).toHaveBeenCalledWith('enabled');
  });
});
