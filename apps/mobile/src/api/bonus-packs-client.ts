import { getRuntimeEnvironment } from '@/config/runtime-environment';

import { createBonusPackService } from './bonus-packs';
import { apiClient } from './index';

const service = createBonusPackService({
  client: apiClient,
  apiBaseUrl: getRuntimeEnvironment().apiBaseUrl,
});

export const getBonusPackPage = service.page;
export const getBonusPack = service.detail;
export const openBonusPack = service.open;
