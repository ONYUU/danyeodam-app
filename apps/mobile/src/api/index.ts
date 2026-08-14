import { removeLocalSession } from '@/auth/session';
import { supabase } from '@/auth/supabase';
import { getRuntimeEnvironment } from '@/config/runtime-environment';

import { createApiClient } from './client';

const environment = getRuntimeEnvironment();

export const apiClient = createApiClient({
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

export {
  ApiResponseError,
  ApiTransportError,
  createApiClient,
  type ApiCacheAwareResult,
  type ApiCacheRequestOptions,
  type ApiClient,
  type ApiClientDependencies,
  type ApiRequestOptions,
  type ApiTransportFailure,
} from './client';

export {
  createBlocksService,
  parseUserBlocksPage,
  type UserBlock,
  type UserBlocksPage,
} from './blocks';

export {
  createAccountDeletionService,
  parseAccountDeletionAccepted,
  parseAccountDeletionStatus,
  type AccountDeletionAccepted,
  type AccountDeletionCredential,
  type AccountDeletionStatus,
} from './account-deletion';

export {
  LocationConsentRequestError,
  createLocationConsentService,
  parseLocationConsent,
  parseLocationWithdrawal,
  type LocationConsent,
  type LocationConsentResult,
  type LocationConsentState,
  type LocationPolicyRequirement,
  type LocationWithdrawalResult,
} from './location-consent';

export {
  LocationRightsRequestError,
  createLocationRightsService,
  parseLocationCorrectionCreated,
  parseLocationCorrections,
  parseLocationCorrectionsPage,
  parseLocationCorrectionSubjectsPage,
  parseLocationUseFactsPage,
  type LocationCorrection,
  type LocationCorrectionInput,
  type LocationCorrectionReason,
  type LocationCorrectionStatus,
  type LocationCorrectionsPage,
  type LocationCorrectionSubject,
  type LocationCorrectionSubjectsPage,
  type LocationFactFailure,
  type LocationUseFact,
  type LocationUseFactsPage,
} from './location-rights';
