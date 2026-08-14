import { describe, expect, it, vi } from 'vitest';

import {
  createLocalePreferenceStorage,
  parseStoredLocale,
} from './locale-preference';

describe('locale preference storage', () => {
  it('accepts only one of the six supported locale identifiers', () => {
    expect(parseStoredLocale('zh-Hant')).toBe('zh-Hant');
    expect(parseStoredLocale('en-US')).toBeNull();
    expect(parseStoredLocale('')).toBeNull();
    expect(parseStoredLocale(null)).toBeNull();
  });

  it('loads and saves through the injected platform backend', async () => {
    const backend = {
      getItem: vi.fn(async () => 'vi'),
      setItem: vi.fn(async () => undefined),
    };
    const storage = createLocalePreferenceStorage(backend);

    await expect(storage.load()).resolves.toBe('vi');
    await storage.save('ja');
    expect(backend.setItem).toHaveBeenCalledWith('ja');
  });
});
