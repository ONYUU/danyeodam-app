import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { createHapticPreferenceStorage } from './haptic-preference';

const HAPTIC_PREFERENCE_KEY = 'danyeodam.bonus-pack.reveal-haptics';
const secureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  keychainService: 'kr.danyeodam.app.preferences',
} satisfies SecureStore.SecureStoreOptions;

const nativeStorage = createHapticPreferenceStorage({
  getItem() {
    return SecureStore.getItemAsync(HAPTIC_PREFERENCE_KEY, secureStoreOptions);
  },
  setItem(value) {
    return SecureStore.setItemAsync(
      HAPTIC_PREFERENCE_KEY,
      value,
      secureStoreOptions,
    );
  },
});

const webStorage = createHapticPreferenceStorage({
  async getItem() {
    return globalThis.localStorage?.getItem(HAPTIC_PREFERENCE_KEY) ?? null;
  },
  async setItem(value) {
    globalThis.localStorage?.setItem(HAPTIC_PREFERENCE_KEY, value);
  },
});

export const hapticPreferenceStorage = Platform.OS === 'web'
  ? webStorage
  : nativeStorage;
