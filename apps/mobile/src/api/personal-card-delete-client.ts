import { apiClient } from './index';
import { createPersonalCardDeleteService } from './personal-card-delete';

export const personalCardDeleteService = createPersonalCardDeleteService(apiClient);
