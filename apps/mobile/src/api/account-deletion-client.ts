import { createAccountDeletionService } from './account-deletion';
import { apiClient } from './index';

const service = createAccountDeletionService(apiClient);

export const requestAccountDeletion = service.request;
export const getAccountDeletionStatus = service.status;
