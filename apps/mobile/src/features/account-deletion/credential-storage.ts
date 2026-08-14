import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import {
  ACCOUNT_DELETION_CREDENTIAL_KEY,
  createAccountDeletionCredentialStore,
  type AccountDeletionCredentialBackend,
} from './credential';

export const ACCOUNT_DELETION_SECURE_STORE_OPTIONS = Object.freeze({
  keychainService: 'kr.danyeodam.app.account-deletion',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
}) satisfies SecureStore.SecureStoreOptions;

const nativeBackend: AccountDeletionCredentialBackend = {
  getItem() {
    return SecureStore.getItemAsync(
      ACCOUNT_DELETION_CREDENTIAL_KEY,
      ACCOUNT_DELETION_SECURE_STORE_OPTIONS,
    );
  },
  setItem(value) {
    return SecureStore.setItemAsync(
      ACCOUNT_DELETION_CREDENTIAL_KEY,
      value,
      ACCOUNT_DELETION_SECURE_STORE_OPTIONS,
    );
  },
  removeItem() {
    return SecureStore.deleteItemAsync(
      ACCOUNT_DELETION_CREDENTIAL_KEY,
      ACCOUNT_DELETION_SECURE_STORE_OPTIONS,
    );
  },
};

let volatileWebValue: string | null = null;
const volatileWebBackend: AccountDeletionCredentialBackend = {
  async getItem() { return volatileWebValue; },
  async setItem(value) { volatileWebValue = value; },
  async removeItem() { volatileWebValue = null; },
};

export const accountDeletionCredentialStore = createAccountDeletionCredentialStore(
  Platform.OS === 'web' ? volatileWebBackend : nativeBackend,
);
