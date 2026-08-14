import type { LocationCorrectionReason } from '@/api/location-rights';
import { ApiResponseError, ApiTransportError } from '@/api/client';

export type CorrectionAttempt = Readonly<{
  subject: string;
  reason: LocationCorrectionReason;
  clientRequestId: string;
}>;

export function correctionAttemptFor(input: {
  previous: CorrectionAttempt | null;
  subject: string;
  reason: LocationCorrectionReason;
  createClientRequestId(): string;
}): CorrectionAttempt {
  if (
    input.previous?.subject === input.subject
    && input.previous.reason === input.reason
  ) {
    return input.previous;
  }
  return {
    subject: input.subject,
    reason: input.reason,
    clientRequestId: input.createClientRequestId(),
  };
}

export function shouldRetainCorrectionAttempt(error: unknown): boolean {
  return error instanceof ApiTransportError
    || (error instanceof ApiResponseError && error.status >= 500);
}
