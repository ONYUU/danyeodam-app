import { getRuntimeEnvironment } from '@/config/runtime-environment';

import { createAcquireService } from './acquire';
import { apiClient } from './index';

export const acquireAtSpot = createAcquireService({
  client: apiClient,
  apiBaseUrl: getRuntimeEnvironment().apiBaseUrl,
});
