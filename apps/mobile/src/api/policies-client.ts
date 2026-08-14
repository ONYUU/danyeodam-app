import { apiClient } from './index';
import { createPoliciesService } from './policies';

const service = createPoliciesService(apiClient);

export const acceptCurrentPolicies = service.accept;
