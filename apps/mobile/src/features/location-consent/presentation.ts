import type { LocationConsentResult } from '@/api/location-consent';

export type LocationConsentPresentation =
  | 'active'
  | 'paused'
  | 'required'
  | 'withdrawal_pending';

export function locationConsentPresentation(
  result: LocationConsentResult,
): LocationConsentPresentation {
  if (result.status === 'missing') return 'required';
  if (result.consent.state === 'withdrawal_pending') return 'withdrawal_pending';
  if (!result.consent.isCurrent) return 'required';
  return result.consent.state === 'paused' ? 'paused' : 'active';
}
