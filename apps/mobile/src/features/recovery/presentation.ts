import { ApiResponseError, ApiTransportError } from '@/api/client';
import { SensitiveCodeInputError } from '@/api/sensitive-codes';

export type RecoveryIssueFailure =
  | 'no_acquisition'
  | 'session'
  | 'rate_limited'
  | 'uncertain'
  | 'error';

export type RecoveryClaimFailure =
  | 'invalid'
  | 'not_found'
  | 'conflict'
  | 'forbidden'
  | 'rate_limited'
  | 'session'
  | 'uncertain'
  | 'error';

export function recoveryIssueFailure(error: unknown): RecoveryIssueFailure {
  if (error instanceof ApiTransportError) {
    return error.failure === 'AUTH_SESSION_UNAVAILABLE' ? 'session' : 'uncertain';
  }
  if (error instanceof ApiResponseError) {
    if (error.status === 401 || error.code === 'UNAUTHORIZED') {
      return 'session';
    }
    if (error.code === 'FORBIDDEN') {
      return 'no_acquisition';
    }
    if (error.status === 429 || error.code === 'RATE_LIMITED') {
      return 'rate_limited';
    }
  }
  return 'error';
}

export function recoveryClaimFailure(error: unknown): RecoveryClaimFailure {
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
    if (error.status === 409 || error.code === 'RECOVERY_CONFLICT') {
      return 'conflict';
    }
    if (error.status === 403 || error.code === 'FORBIDDEN') {
      return 'forbidden';
    }
    if (error.status === 429 || error.code === 'RATE_LIMITED') {
      return 'rate_limited';
    }
  }
  return 'error';
}
