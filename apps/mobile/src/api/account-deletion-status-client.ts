import { getRuntimeEnvironment } from '@/config/runtime-environment';

import { createAccountDeletionService } from './account-deletion';
import { createApiClient } from './client';

// This client is intentionally incapable of reading or mutating Supabase Auth.
// It is safe to import before the local minimum-age boundary because the only
// exported operation uses the public deletion status credential.
const publicStatusClient = createApiClient({
  apiBaseUrl: getRuntimeEnvironment().apiBaseUrl,
  async getAccessToken() {
    return null;
  },
  async clearLocalSession() {
    return undefined;
  },
});

const service = createAccountDeletionService(publicStatusClient);

export const getPublicAccountDeletionStatus = service.status;
