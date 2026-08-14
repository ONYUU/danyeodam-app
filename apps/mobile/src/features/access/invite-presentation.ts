import { ApiResponseError, ApiTransportError } from '@/api/client';
import { SensitiveCodeInputError } from '@/api/sensitive-codes';

export type InviteFailure =
  | 'invalid'
  | 'not_found'
  | 'rate_limited'
  | 'session'
  | 'forbidden'
  | 'uncertain'
  | 'error';

export function inviteFailure(error: unknown): InviteFailure {
  if (error instanceof SensitiveCodeInputError) {
    return 'invalid';
  }
  if (error instanceof ApiTransportError) {
    return error.failure === 'AUTH_SESSION_UNAVAILABLE' ? 'session' : 'uncertain';
  }
  if (error instanceof ApiResponseError) {
    if (error.status === 401 || error.code === 'UNAUTHORIZED') {
      return 'session';
    }
    if (error.status === 400 || error.code === 'VALIDATION_FAILED') {
      return 'invalid';
    }
    if (error.status === 404 || error.code === 'NOT_FOUND') {
      return 'not_found';
    }
    if (error.status === 429 || error.code === 'RATE_LIMITED') {
      return 'rate_limited';
    }
    if (
      error.status === 403
      || error.code === 'FORBIDDEN'
      || error.code === 'GATE_CLOSED'
    ) {
      return 'forbidden';
    }
  }
  return 'error';
}
