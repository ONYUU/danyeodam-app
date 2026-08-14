import { apiClient } from './index';
import { createParticipantService } from './participants';

export const redeemParticipantInvite = createParticipantService(apiClient);
