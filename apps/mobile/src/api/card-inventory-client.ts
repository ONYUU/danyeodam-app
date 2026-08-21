import { getRuntimeEnvironment } from '@/config/runtime-environment';

import { createCardInventoryService } from './card-inventory';
import { apiClient } from './index';

export const getCardInventoryPage = createCardInventoryService({
  client: apiClient,
  apiBaseUrl: getRuntimeEnvironment().apiBaseUrl,
});
