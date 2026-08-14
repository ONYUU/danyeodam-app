import { describe, expect, it, vi } from 'vitest';

import {
  createMinimumAgeDevicePassStore,
  MINIMUM_AGE_DEVICE_PASS,
  SERIALIZED_MINIMUM_AGE_DEVICE_PASS,
  type MinimumAgeDevicePassBackend,
} from './device-pass';

function memoryBackend(initialValue: string | null = null) {
  let value = initialValue;
  const backend: MinimumAgeDevicePassBackend = {
    getItem: vi.fn(async () => value),
    setItem: vi.fn(async (nextValue) => {
      value = nextValue;
    }),
    removeItem: vi.fn(async () => {
      value = null;
    }),
  };
  return { backend, read: () => value };
}

describe('minimum-age device pass storage', () => {
  it('stores only the versioned boolean pass marker', async () => {
    const memory = memoryBackend();
    const store = createMinimumAgeDevicePassStore(memory.backend);

    await store.save();

    expect(memory.read()).toBe(SERIALIZED_MINIMUM_AGE_DEVICE_PASS);
    expect(JSON.parse(memory.read() ?? '{}')).toEqual(MINIMUM_AGE_DEVICE_PASS);
    expect(Object.keys(JSON.parse(memory.read() ?? '{}')).sort()).toEqual([
      'minimum_age_passed',
      'version',
    ]);
    expect(memory.read()).not.toMatch(/birth|dob|year|date|hash/iu);
  });

  it('requires the exact current version and invalidates stale records', async () => {
    const memory = memoryBackend(
      JSON.stringify({ minimum_age_passed: true, version: 'legacy-v0' }),
    );
    const store = createMinimumAgeDevicePassStore(memory.backend);

    await expect(store.load()).resolves.toBe(false);
    expect(memory.backend.removeItem).toHaveBeenCalledOnce();
    expect(memory.read()).toBeNull();
  });

  it('rejects markers containing extra personal fields', async () => {
    const memory = memoryBackend(JSON.stringify({
      ...MINIMUM_AGE_DEVICE_PASS,
      birth_year: '2000',
    }));
    const store = createMinimumAgeDevicePassStore(memory.backend);

    await expect(store.load()).resolves.toBe(false);
    expect(memory.read()).toBeNull();
  });

  it('clears the pass after completed account deletion', async () => {
    const memory = memoryBackend(SERIALIZED_MINIMUM_AGE_DEVICE_PASS);
    const store = createMinimumAgeDevicePassStore(memory.backend);
    await store.clear();
    expect(memory.read()).toBeNull();
  });
});
