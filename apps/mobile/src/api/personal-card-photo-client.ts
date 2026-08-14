import { removeLocalSession } from '@/auth/session';
import { supabase } from '@/auth/supabase';
import { getRuntimeEnvironment } from '@/config/runtime-environment';

import { apiClient } from './index';
import {
  createOwnedPersonalCardPhotoLoader,
  createPersonalCardPhotoService,
} from './personal-card-photo';

const environment = getRuntimeEnvironment();

export const personalCardPhotoService = createPersonalCardPhotoService({
  client: apiClient,
  supabaseUrl: environment.supabaseUrl,
});

export const loadOwnedPersonalCardPhoto = createOwnedPersonalCardPhotoLoader({
  apiBaseUrl: environment.apiBaseUrl,
  async getAccessToken() {
    const result = await supabase.auth.getSession();
    if (result.error !== null) {
      throw new Error('AUTH_SESSION_READ_FAILED');
    }
    return result.data.session?.access_token ?? null;
  },
  async clearLocalSession() {
    await removeLocalSession(supabase.auth);
  },
});
