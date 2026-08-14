import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import {
  createChunkedStorage,
  type AsyncKeyValueStorage,
} from './chunked-storage';

const secureStoreOptions: SecureStore.SecureStoreOptions = {
  keychainService: 'kr.danyeodam.app.auth',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

const nativeBackend: AsyncKeyValueStorage = {
  getItem(key) {
    return SecureStore.getItemAsync(key, secureStoreOptions);
  },
  setItem(key, value) {
    return SecureStore.setItemAsync(key, value, secureStoreOptions);
  },
  removeItem(key) {
    return SecureStore.deleteItemAsync(key, secureStoreOptions);
  },
};

const webBackend: AsyncKeyValueStorage = {
  async getItem(key) {
    return typeof globalThis.localStorage === 'undefined'
      ? null
      : globalThis.localStorage.getItem(key);
  },
  async setItem(key, value) {
    globalThis.localStorage?.setItem(key, value);
  },
  async removeItem(key) {
    globalThis.localStorage?.removeItem(key);
  },
};

export const sessionStorage = createChunkedStorage(
  Platform.OS === 'web' ? webBackend : nativeBackend,
);
