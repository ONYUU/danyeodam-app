import { apiClient } from './index';
import { createMinimumAgeAttestationService } from './minimum-age-attestation';

const service = createMinimumAgeAttestationService(apiClient);

export const submitMinimumAgeAttestation = service.submit;
