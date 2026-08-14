import { personalCardDeleteService } from '@/api/personal-card-delete-client';
import type { SessionBindingGeneration } from '@/features/session-data/generation';
import { createClientRequestId } from '@/platform/client-request-id';

import { createPersonalCardDeleteCoordinator } from './delete-coordinator';

export function createRuntimePersonalCardDeleteCoordinator(input: {
  isGenerationCurrent(generation: SessionBindingGeneration): boolean;
}) {
  return createPersonalCardDeleteCoordinator({
    createClientRequestId,
    service: personalCardDeleteService,
    isGenerationCurrent: input.isGenerationCurrent,
  });
}
