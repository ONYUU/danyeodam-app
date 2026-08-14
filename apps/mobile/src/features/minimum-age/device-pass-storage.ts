import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import {
  createMinimumAgeDevicePassStore,
  type MinimumAgeDevicePassBackend,
} from './device-pass';

const DEVICE_PASS_KEY = 'danyeodam.minimum-age-device-pass';

export const MINIMUM_AGE_SECURE_STORE_OPTIONS = Object.freeze({
  keychainService: 'kr.danyeodam.app.minimum-age',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
}) satisfies SecureStore.SecureStoreOptions;

const nativeBackend: MinimumAgeDevicePassBackend = {
  getItem() {
    return SecureStore.getItemAsync(
      DEVICE_PASS_KEY,
      MINIMUM_AGE_SECURE_STORE_OPTIONS,
    );
  },
  setItem(value) {
    return SecureStore.setItemAsync(
      DEVICE_PASS_KEY,
      value,
      MINIMUM_AGE_SECURE_STORE_OPTIONS,
    );
  },
  removeItem() {
    return SecureStore.deleteItemAsync(
      DEVICE_PASS_KEY,
      MINIMUM_AGE_SECURE_STORE_OPTIONS,
    );
  },
};

let volatileWebValue: string | null = null;
const volatileWebBackend: MinimumAgeDevicePassBackend = {
  async getItem() {
    return volatileWebValue;
  },
  async setItem(value) {
    volatileWebValue = value;
  },
  async removeItem() {
    volatileWebValue = null;
  },
};

export const minimumAgeDevicePassStore = createMinimumAgeDevicePassStore(
  Platform.OS === 'web' ? volatileWebBackend : nativeBackend,
);
