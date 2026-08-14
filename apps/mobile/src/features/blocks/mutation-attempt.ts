import { ApiResponseError, ApiTransportError } from '@/api/client';

export type BlockMutationAttempt = Readonly<{
  subjectId: string;
  clientActionId: string;
}>;

export function mutationAttemptFor(input: {
  previous: BlockMutationAttempt | null;
  subjectId: string;
  createClientActionId(): string;
}): BlockMutationAttempt {
  if (input.previous?.subjectId === input.subjectId) {
    return input.previous;
  }
  return {
    subjectId: input.subjectId,
    clientActionId: input.createClientActionId(),
  };
}

export function shouldRetainBlockMutationAttempt(error: unknown): boolean {
  return error instanceof ApiTransportError
    || (
      error instanceof ApiResponseError
      && (error.status >= 500 || error.code === 'RATE_LIMITED')
    );
}
