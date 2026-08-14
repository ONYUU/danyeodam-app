import type { ApiClient } from './client';
import { requireInviteCode } from './sensitive-codes';

export function createParticipantService(client: ApiClient) {
  return async function redeemParticipantInvite(inviteCode: string): Promise<void> {
    const code = requireInviteCode(inviteCode);
    await client<void>('/api/participants/redeem', {
      method: 'POST',
      json: { invite_code: code },
    });
  };
}
