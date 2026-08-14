import type { AuthStatus } from '@/auth/auth-provider';

export type AttestationRequestState =
  | 'waiting'
  | 'submitting'
  | 'ready'
  | 'error';

export type AttestationPresentation =
  | 'loading'
  | 'session_error'
  | 'request_error'
  | 'ready';

export function canEnterPrivacyRightsFromAttestation(
  presentation: AttestationPresentation,
): boolean {
  return presentation !== 'ready';
}

export function resolveAttestationPresentation(input: {
  authStatus: AuthStatus;
  hasSession: boolean;
  requestState: AttestationRequestState;
}): AttestationPresentation {
  if (
    input.authStatus === 'error'
    || input.authStatus === 'signed_out'
    || (input.authStatus === 'ready' && !input.hasSession)
  ) {
    return 'session_error';
  }
  if (input.requestState === 'error') {
    return 'request_error';
  }
  if (
    input.authStatus === 'ready'
    && input.hasSession
    && input.requestState === 'ready'
  ) {
    return 'ready';
  }
  return 'loading';
}
