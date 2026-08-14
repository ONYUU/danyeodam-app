import { getRuntimeEnvironment } from '@/config/runtime-environment';

import { createCurrentPoliciesService } from './policies';
import { createPublicPolicyApiClient } from './public-policy-transport';

const environment = getRuntimeEnvironment();
const service = createCurrentPoliciesService(createPublicPolicyApiClient({
  apiBaseUrl: environment.apiBaseUrl,
}));

export const getCurrentPolicies = service.current;
export const getCurrentPolicyManifest = service.currentManifest;
