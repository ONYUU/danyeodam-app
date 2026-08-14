import { createAccessService } from './access';
import { apiClient } from './index';

export const getAccess = createAccessService(apiClient);
