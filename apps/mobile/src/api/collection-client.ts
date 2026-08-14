import { getRuntimeEnvironment } from '@/config/runtime-environment';

import { createCollectionService } from './collection';
import { apiClient } from './index';

const service = createCollectionService({
  client: apiClient,
  apiBaseUrl: getRuntimeEnvironment().apiBaseUrl,
});

export const getCollectionPage = service.page;
