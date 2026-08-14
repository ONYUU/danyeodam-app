import { apiClient } from './index';
import { createLocationConsentService } from './location-consent';

const service = createLocationConsentService(apiClient);

export const getLocationConsent = service.get;
export const acceptLocationConsent = service.accept;
export const setLocationConsentState = service.setState;
export const withdrawLocationConsent = service.withdraw;
