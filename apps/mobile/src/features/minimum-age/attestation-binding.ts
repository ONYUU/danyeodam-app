import {
  isSameSessionBindingGeneration,
  type SessionBindingGeneration,
} from '@/features/session-data/generation';

import type { AttestationRequestState } from './attestation-presentation';

export type BindingAttestationResult = Readonly<{
  generation: SessionBindingGeneration;
  sessionUserId: string;
  state: 'ready' | 'error';
}>;

export function resolveBindingAttestationRequestState(input: {
  generation: SessionBindingGeneration;
  result: BindingAttestationResult | null;
  sessionUserId: string | null;
}): AttestationRequestState {
  if (input.sessionUserId === null) {
    return 'waiting';
  }

  return input.result?.sessionUserId === input.sessionUserId
    && isSameSessionBindingGeneration(input.result.generation, input.generation)
    ? input.result.state
    : 'submitting';
}

export async function runBindingAttestationAttempt(input: {
  generation: SessionBindingGeneration;
  isGenerationCurrent(generation: SessionBindingGeneration): boolean;
  sessionUserId: string;
  signal: AbortSignal;
  submit(signal: AbortSignal): Promise<void>;
}): Promise<BindingAttestationResult | null> {
  let state: BindingAttestationResult['state'] = 'ready';
  try {
    await input.submit(input.signal);
  } catch {
    if (input.signal.aborted) {
      return null;
    }
    state = 'error';
  }

  if (!input.isGenerationCurrent(input.generation)) {
    return null;
  }

  return {
    generation: input.generation,
    sessionUserId: input.sessionUserId,
    state,
  };
}
