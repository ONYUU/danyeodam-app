import type { SessionBindingGeneration } from '@/features/session-data/generation';

export type RecoveryClaimMutationResult =
  | { status: 'current' }
  | { status: 'stale' };

export async function runRecoveryClaimMutation(input: {
  generation: SessionBindingGeneration;
  isGenerationCurrent(generation: SessionBindingGeneration): boolean;
  claim(): Promise<void>;
  refreshAfterMutation(): void;
  shouldRefreshAfterError(error: unknown): boolean;
}): Promise<RecoveryClaimMutationResult> {
  try {
    await input.claim();
    const status = input.isGenerationCurrent(input.generation)
      ? 'current'
      : 'stale';
    input.refreshAfterMutation();
    return { status };
  } catch (error) {
    if (input.shouldRefreshAfterError(error)) {
      input.refreshAfterMutation();
    }
    throw error;
  }
}
