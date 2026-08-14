import { MINIMUM_AGE_POLICY_VERSION } from './policy';

export const MINIMUM_AGE_DEVICE_PASS = Object.freeze({
  minimum_age_passed: true as const,
  version: MINIMUM_AGE_POLICY_VERSION,
});

export const SERIALIZED_MINIMUM_AGE_DEVICE_PASS = JSON.stringify(
  MINIMUM_AGE_DEVICE_PASS,
);

export type MinimumAgeDevicePassBackend = {
  getItem(): Promise<string | null>;
  setItem(value: string): Promise<void>;
  removeItem(): Promise<void>;
};

export type MinimumAgeDevicePassStore = {
  load(): Promise<boolean>;
  save(): Promise<void>;
  clear(): Promise<void>;
};

export function createMinimumAgeDevicePassStore(
  backend: MinimumAgeDevicePassBackend,
): MinimumAgeDevicePassStore {
  return {
    async load() {
      const value = await backend.getItem();
      if (value === SERIALIZED_MINIMUM_AGE_DEVICE_PASS) {
        return true;
      }
      if (value !== null) {
        await backend.removeItem();
      }
      return false;
    },
    async save() {
      await backend.setItem(SERIALIZED_MINIMUM_AGE_DEVICE_PASS);
    },
    async clear() {
      await backend.removeItem();
    },
  };
}
