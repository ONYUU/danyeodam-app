import type { SessionBindingGeneration } from './generation';

export type GenerationBoundResult<Value> =
  | { status: 'current'; value: Value }
  | { status: 'stale' };

export async function runGenerationBoundOperation<Value>(input: {
  generation: SessionBindingGeneration;
  isGenerationCurrent(generation: SessionBindingGeneration): boolean;
  work(): Promise<Value>;
}): Promise<GenerationBoundResult<Value>> {
  const value = await input.work();
  return input.isGenerationCurrent(input.generation)
    ? { status: 'current', value }
    : { status: 'stale' };
}
