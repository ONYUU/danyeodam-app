import { apiClient } from './index';
import { createRecoveryService } from './recovery';

const service = createRecoveryService(apiClient);

export const issueRecoveryCode = service.issue;
export const claimRecoveryCode = service.claim;
