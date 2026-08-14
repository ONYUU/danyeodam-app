import { apiClient } from './index';
import { createBlocksService } from './blocks';

const service = createBlocksService(apiClient);

export const blockPublicShareOwner = service.blockShareOwner;
export const getUserBlocksPage = service.list;
export const unblockUser = service.unblock;
