import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { createLocalePreferenceStorage } from './locale-preference';

const LOCALE_KEY = 'danyeodam.locale.preference';
const secureStoreOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  keychainService: 'kr.danyeodam.app.preferences',
};

const nativeStorage = createLocalePreferenceStorage({
  getItem() {
    return SecureStore.getItemAsync(LOCALE_KEY, secureStoreOptions);
  },
  setItem(locale) {
    return SecureStore.setItemAsync(LOCALE_KEY, locale, secureStoreOptions);
  },
});

const webStorage = createLocalePreferenceStorage({
  async getItem() {
    return globalThis.localStorage?.getItem(LOCALE_KEY) ?? null;
  },
  async setItem(locale) {
    globalThis.localStorage?.setItem(LOCALE_KEY, locale);
  },
});

export const localeStorage = Platform.OS === 'web' ? webStorage : nativeStorage;
