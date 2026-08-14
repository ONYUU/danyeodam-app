export type MinimumAgeBoundaryPhase =
  | 'checking'
  | 'collecting'
  | 'saving'
  | 'ineligible'
  | 'storage_error'
  | 'passed';

export const PRE_AGE_BOUNDARY_PHASES = [
  'checking',
  'collecting',
  'saving',
  'ineligible',
  'storage_error',
] as const satisfies readonly MinimumAgeBoundaryPhase[];

export function canEnterPrivacyRightsFromBoundary(
  phase: MinimumAgeBoundaryPhase,
): boolean {
  return phase !== 'passed';
}
