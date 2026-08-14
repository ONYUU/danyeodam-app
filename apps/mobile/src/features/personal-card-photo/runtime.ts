import { personalCardPhotoService } from '@/api/personal-card-photo-client';
import type { SessionBindingGeneration } from '@/features/session-data/generation';
import { createClientRequestId } from '@/platform/client-request-id';

import { createPersonalCardPhotoCoordinator } from './coordinator';
import { selectPersonalCardPhotoFromSystem } from './selection-native';

export function createRuntimePersonalCardPhotoCoordinator(input: {
  isGenerationCurrent(generation: SessionBindingGeneration): boolean;
}) {
  return createPersonalCardPhotoCoordinator({
    createClientRequestId,
    select: selectPersonalCardPhotoFromSystem,
    service: personalCardPhotoService,
    isGenerationCurrent: input.isGenerationCurrent,
  });
}
