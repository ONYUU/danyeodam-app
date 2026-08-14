import type { MinimumAgeDecision } from './policy';

export type MinimumAgeAdmissionOutcome = 'passed' | 'ineligible' | 'invalid';

export async function completeMinimumAgeAdmission(
  decision: MinimumAgeDecision,
  persistPass: () => Promise<void>,
): Promise<MinimumAgeAdmissionOutcome> {
  if (decision !== 'eligible') {
    return decision;
  }
  await persistPass();
  return 'passed';
}

export function renderAfterMinimumAgeBoundary<T>(
  allowed: boolean,
  renderProtectedContent: () => T,
): T | null {
  return allowed ? renderProtectedContent() : null;
}
