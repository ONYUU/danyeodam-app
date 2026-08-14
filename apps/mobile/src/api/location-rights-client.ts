import { apiClient } from './index';
import { createLocationRightsService } from './location-rights';

const service = createLocationRightsService(apiClient);

export const getLocationUseFactsPage = service.facts;
export const getLocationCorrectionSubjectsPage = service.correctionSubjects;
export const getLocationCorrectionsPage = service.correctionsPage;
export const getLocationCorrections = service.corrections;
export const submitLocationCorrection = service.submitCorrection;
