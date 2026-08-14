import { getRuntimeEnvironment } from '@/config/runtime-environment';

import { apiClient } from './index';
import { createSpotsService } from './spots';

const service = createSpotsService({
  client: apiClient,
  apiBaseUrl: getRuntimeEnvironment().apiBaseUrl,
});

export const listSpots = service.list;
