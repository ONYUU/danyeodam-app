import type { AccessProjection } from '@/api/access';

export function canShowReviewerSensitiveActions(
  access: AccessProjection | null,
): boolean {
  return access?.accessType === 'standard';
}
