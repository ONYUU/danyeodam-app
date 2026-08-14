import type {
  PersonalCardCreation,
  PersonalCardPhotoService,
  PersonalCardUploadIssue,
} from '@/api/personal-card-photo';
import { isPersonalCardUploadRetryable } from '@/api/personal-card-photo';
import {
  isSameSessionBindingGeneration,
  type SessionBindingGeneration,
} from '@/features/session-data/generation';

import type { SelectedPersonalCardPhoto } from './selection';

export type PersonalCardPhotoProgress =
  | 'choosing'
  | 'creating'
  | 'requesting_upload'
  | 'uploading';

type AttemptIdentity = {
  acquisitionId: string;
  caption: string;
  generation: SessionBindingGeneration;
};

type IssueRetry = AttemptIdentity & {
  clientRequestId: string;
  stage: 'issue';
  photo: SelectedPersonalCardPhoto;
};

type UploadRetry = AttemptIdentity & {
  stage: 'upload';
  issue: PersonalCardUploadIssue;
  photo: SelectedPersonalCardPhoto;
};

type CreationRetry = AttemptIdentity & {
  stage: 'create';
  tempPath: string;
};

type PendingRetry = IssueRetry | UploadRetry | CreationRetry;

type ActiveAttempt = {
  cancelled: boolean;
  controller: AbortController;
};

export class PersonalCardPhotoFlowError extends Error {
  readonly reason:
    | 'CANCELLED'
    | 'GENERATION_CHANGED'
    | 'IN_PROGRESS'
    | 'RETRY_INPUT_CHANGED';

  constructor(reason: PersonalCardPhotoFlowError['reason']) {
    super(`Personal card photo flow failed with ${reason}.`);
    this.name = 'PersonalCardPhotoFlowError';
    this.reason = reason;
  }
}

function wipeSelectedPhoto(photo: SelectedPersonalCardPhoto): void {
  photo.bytes.fill(0);
}

export function createPersonalCardPhotoCoordinator(dependencies: {
  createClientRequestId(): string;
  select(signal: AbortSignal): Promise<SelectedPersonalCardPhoto | null>;
  service: PersonalCardPhotoService;
  isGenerationCurrent(generation: SessionBindingGeneration): boolean;
}) {
  let generation: SessionBindingGeneration | null = null;
  let activeAttempt: ActiveAttempt | null = null;
  let pendingRetry: PendingRetry | null = null;

  const clearPendingRetry = () => {
    if (pendingRetry?.stage === 'issue' || pendingRetry?.stage === 'upload') {
      wipeSelectedPhoto(pendingRetry.photo);
    }
    pendingRetry = null;
  };

  const cancelActiveAttempt = () => {
    if (activeAttempt !== null) {
      activeAttempt.cancelled = true;
      activeAttempt.controller.abort();
    }
    clearPendingRetry();
  };

  const setGeneration = (nextGeneration: SessionBindingGeneration) => {
    if (
      generation !== null
      && !isSameSessionBindingGeneration(generation, nextGeneration)
    ) {
      cancelActiveAttempt();
    }
    generation = nextGeneration;
  };

  const ensureCurrent = (
    runGeneration: SessionBindingGeneration,
    attempt: ActiveAttempt,
  ) => {
    if (
      attempt.cancelled
      || generation === null
      || !isSameSessionBindingGeneration(generation, runGeneration)
      || !dependencies.isGenerationCurrent(runGeneration)
    ) {
      throw new PersonalCardPhotoFlowError(
        attempt.cancelled ? 'CANCELLED' : 'GENERATION_CHANGED',
      );
    }
  };

  async function continuePending(
    attempt: ActiveAttempt,
    onProgress: (progress: PersonalCardPhotoProgress) => void,
  ): Promise<PersonalCardCreation> {
    const retry = pendingRetry;
    if (retry === null) {
      throw new PersonalCardPhotoFlowError('CANCELLED');
    }
    ensureCurrent(retry.generation, attempt);

    if (retry.stage === 'issue') {
      onProgress('requesting_upload');
      try {
        const issue = await dependencies.service.issueUpload({
          clientRequestId: retry.clientRequestId,
          contentType: retry.photo.contentType,
          sizeBytes: retry.photo.sizeBytes,
          signal: attempt.controller.signal,
        });
        pendingRetry = {
          stage: 'upload',
          acquisitionId: retry.acquisitionId,
          caption: retry.caption,
          generation: retry.generation,
          issue,
          photo: retry.photo,
        };
      } catch (error) {
        ensureCurrent(retry.generation, attempt);
        if (!isPersonalCardUploadRetryable(error)) {
          clearPendingRetry();
        }
        throw error;
      }
    }

    const uploadRetry = pendingRetry;
    if (uploadRetry?.stage === 'upload') {
      onProgress('uploading');
      try {
        await dependencies.service.upload({
          issue: uploadRetry.issue,
          bytes: uploadRetry.photo.bytes,
          contentType: uploadRetry.photo.contentType,
          signal: attempt.controller.signal,
        });
      } catch (error) {
        ensureCurrent(uploadRetry.generation, attempt);
        if (!isPersonalCardUploadRetryable(error)) {
          clearPendingRetry();
        }
        throw error;
      }
      wipeSelectedPhoto(uploadRetry.photo);
      pendingRetry = {
        stage: 'create',
        acquisitionId: uploadRetry.acquisitionId,
        caption: uploadRetry.caption,
        generation: uploadRetry.generation,
        tempPath: uploadRetry.issue.tempPath,
      };
    }

    const creation = pendingRetry;
    if (creation === null || creation.stage !== 'create') {
      throw new PersonalCardPhotoFlowError('CANCELLED');
    }
    ensureCurrent(creation.generation, attempt);
    onProgress('creating');
    try {
      const result = await dependencies.service.create({
        acquisitionId: creation.acquisitionId,
        tempPath: creation.tempPath,
        caption: creation.caption,
        signal: attempt.controller.signal,
      });
      pendingRetry = null;
      return result;
    } catch (error) {
      ensureCurrent(creation.generation, attempt);
      if (!isPersonalCardUploadRetryable(error)) {
        clearPendingRetry();
      }
      throw error;
    }
  }

  return {
    setGeneration,
    cancelActiveAttempt,
    hasPendingRetry(): boolean {
      return pendingRetry !== null;
    },
    async run(input: {
      acquisitionId: string;
      caption: string;
      generation: SessionBindingGeneration;
      onProgress(progress: PersonalCardPhotoProgress): void;
    }): Promise<PersonalCardCreation | null> {
      setGeneration(input.generation);
      if (activeAttempt !== null) {
        throw new PersonalCardPhotoFlowError('IN_PROGRESS');
      }
      const attempt: ActiveAttempt = {
        cancelled: false,
        controller: new AbortController(),
      };
      activeAttempt = attempt;
      let selectedPhoto: SelectedPersonalCardPhoto | null = null;
      try {
        ensureCurrent(input.generation, attempt);
        if (pendingRetry !== null) {
          if (
            pendingRetry.acquisitionId !== input.acquisitionId
            || pendingRetry.caption !== input.caption
            || !isSameSessionBindingGeneration(
              pendingRetry.generation,
              input.generation,
            )
          ) {
            throw new PersonalCardPhotoFlowError('RETRY_INPUT_CHANGED');
          }
          return await continuePending(attempt, input.onProgress);
        }

        input.onProgress('choosing');
        selectedPhoto = await dependencies.select(attempt.controller.signal);
        ensureCurrent(input.generation, attempt);
        if (selectedPhoto === null) {
          return null;
        }

        pendingRetry = {
          stage: 'issue',
          acquisitionId: input.acquisitionId,
          caption: input.caption,
          clientRequestId: dependencies.createClientRequestId(),
          generation: input.generation,
          photo: selectedPhoto,
        };
        selectedPhoto = null;
        return await continuePending(attempt, input.onProgress);
      } catch (error) {
        if (
          attempt.cancelled
          || !dependencies.isGenerationCurrent(input.generation)
        ) {
          clearPendingRetry();
          throw new PersonalCardPhotoFlowError(
            attempt.cancelled ? 'CANCELLED' : 'GENERATION_CHANGED',
          );
        }
        throw error;
      } finally {
        if (selectedPhoto !== null) {
          wipeSelectedPhoto(selectedPhoto);
        }
        if (activeAttempt === attempt) {
          activeAttempt = null;
        }
      }
    },
  };
}

export type PersonalCardPhotoCoordinator = ReturnType<
  typeof createPersonalCardPhotoCoordinator
>;
