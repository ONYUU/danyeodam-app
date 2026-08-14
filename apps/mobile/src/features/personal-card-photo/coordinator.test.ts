import { describe, expect, it, vi } from 'vitest';

import { ApiResponseError, ApiTransportError } from '@/api/client';
import {
  PersonalCardUploadError,
  type PersonalCardPhotoService,
} from '@/api/personal-card-photo';
import type { SessionBindingGeneration } from '@/features/session-data/generation';

import { createPersonalCardPhotoCoordinator } from './coordinator';
import type { SelectedPersonalCardPhoto } from './selection';

const acquisitionId = '11111111-1111-4111-8111-111111111111';
const personalCardId = '22222222-2222-4222-8222-222222222222';
const clientRequestId = '55555555-5555-4555-8555-555555555555';
const tempPath = '33333333-3333-4333-8333-333333333333/44444444-4444-4444-8444-444444444444.jpg';
const issue = {
  uploadUrl: `https://project.supabase.co/storage/v1/object/upload/sign/personal-card-temp/${tempPath}?token=${'A'.repeat(30)}`,
  tempPath,
};

function generation(authToken: symbol, id: number): SessionBindingGeneration {
  return { authToken, bindingVersion: id, id };
}

function selected(): SelectedPersonalCardPhoto {
  return {
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 1]),
    contentType: 'image/jpeg',
    sizeBytes: 4,
  };
}

function service(overrides: Partial<PersonalCardPhotoService> = {}): PersonalCardPhotoService {
  return {
    issueUpload: vi.fn(async () => issue),
    upload: vi.fn(async () => 'uploaded' as const),
    create: vi.fn(async () => ({ id: personalCardId })),
    ...overrides,
  };
}

describe('generation-bound personal-card photo coordinator', () => {
  it('selects, uploads, creates, and wipes source bytes after upload', async () => {
    const current = generation(Symbol('auth'), 1);
    const photo = selected();
    const photoService = service();
    const progress = vi.fn();
    const coordinator = createPersonalCardPhotoCoordinator({
      createClientRequestId: () => clientRequestId,
      select: async () => photo,
      service: photoService,
      isGenerationCurrent: (candidate) => candidate === current,
    });

    await expect(coordinator.run({
      acquisitionId,
      caption: 'memory',
      generation: current,
      onProgress: progress,
    })).resolves.toEqual({ id: personalCardId });
    expect(progress.mock.calls.map(([value]) => value)).toEqual([
      'choosing',
      'requesting_upload',
      'uploading',
      'creating',
    ]);
    expect(photo.bytes).toEqual(new Uint8Array([0, 0, 0, 0]));
    expect(coordinator.hasPendingRetry()).toBe(false);
  });

  it('retries an ambiguous PUT with the same signed URL and bytes without repicking', async () => {
    const current = generation(Symbol('auth'), 1);
    const photo = selected();
    const select = vi.fn(async () => photo);
    const issueUpload = vi.fn(async () => issue);
    const upload = vi.fn()
      .mockRejectedValueOnce(new PersonalCardUploadError('NETWORK_ERROR'))
      .mockResolvedValueOnce('already_uploaded');
    const photoService = service({ issueUpload, upload });
    const coordinator = createPersonalCardPhotoCoordinator({
      createClientRequestId: () => clientRequestId,
      select,
      service: photoService,
      isGenerationCurrent: (candidate) => candidate === current,
    });
    const input = {
      acquisitionId,
      caption: '',
      generation: current,
      onProgress: vi.fn(),
    };

    await expect(coordinator.run(input)).rejects.toMatchObject({
      reason: 'NETWORK_ERROR',
    });
    expect(coordinator.hasPendingRetry()).toBe(true);
    await expect(coordinator.run(input)).resolves.toEqual({ id: personalCardId });
    expect(select).toHaveBeenCalledOnce();
    expect(issueUpload).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(photo.bytes).toEqual(new Uint8Array([0, 0, 0, 0]));
  });

  it('continues an uncertain signed-URL request with the same in-memory selection', async () => {
    const current = generation(Symbol('auth'), 1);
    const photo = selected();
    const select = vi.fn(async () => photo);
    const issueUpload = vi.fn()
      .mockRejectedValueOnce(new ApiTransportError('NETWORK_ERROR'))
      .mockResolvedValueOnce(issue);
    const coordinator = createPersonalCardPhotoCoordinator({
      createClientRequestId: () => clientRequestId,
      select,
      service: service({ issueUpload }),
      isGenerationCurrent: (candidate) => candidate === current,
    });
    const input = {
      acquisitionId,
      caption: '',
      generation: current,
      onProgress: vi.fn(),
    };

    await expect(coordinator.run(input)).rejects.toMatchObject({
      failure: 'NETWORK_ERROR',
    });
    expect(coordinator.hasPendingRetry()).toBe(true);
    expect(photo.bytes).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 1]));
    await expect(coordinator.run(input)).resolves.toEqual({ id: personalCardId });
    expect(select).toHaveBeenCalledOnce();
    expect(issueUpload).toHaveBeenCalledTimes(2);
    expect(issueUpload).toHaveBeenNthCalledWith(1, expect.objectContaining({
      clientRequestId,
    }));
    expect(issueUpload).toHaveBeenNthCalledWith(2, expect.objectContaining({
      clientRequestId,
    }));
    expect(photo.bytes).toEqual(new Uint8Array([0, 0, 0, 0]));
  });

  it('continues the same upload request after current policy acceptance', async () => {
    const current = generation(Symbol('auth'), 1);
    const photo = selected();
    const select = vi.fn(async () => photo);
    const issueUpload = vi.fn()
      .mockRejectedValueOnce(new ApiResponseError({
        code: 'POLICY_ACCEPTANCE_REQUIRED',
        status: 409,
        requestId: null,
        details: {
          required: [
            { type: 'terms_of_use', version: '2026-08-12' },
            { type: 'community_guidelines', version: '2026-08-12' },
          ],
        },
      }))
      .mockResolvedValueOnce(issue);
    const coordinator = createPersonalCardPhotoCoordinator({
      createClientRequestId: () => clientRequestId,
      select,
      service: service({ issueUpload }),
      isGenerationCurrent: (candidate) => candidate === current,
    });
    const input = {
      acquisitionId,
      caption: '',
      generation: current,
      onProgress: vi.fn(),
    };

    await expect(coordinator.run(input)).rejects.toMatchObject({
      code: 'POLICY_ACCEPTANCE_REQUIRED',
    });
    expect(coordinator.hasPendingRetry()).toBe(true);
    await expect(coordinator.run(input)).resolves.toEqual({ id: personalCardId });
    expect(select).toHaveBeenCalledOnce();
    expect(issueUpload).toHaveBeenCalledTimes(2);
    expect(issueUpload.mock.calls[0]?.[0].clientRequestId).toBe(clientRequestId);
    expect(issueUpload.mock.calls[1]?.[0].clientRequestId).toBe(clientRequestId);
  });

  it('retries ambiguous promotion using the same temp path without retaining photo bytes', async () => {
    const current = generation(Symbol('auth'), 1);
    const photo = selected();
    const select = vi.fn(async () => photo);
    const upload = vi.fn(async () => 'uploaded' as const);
    const create = vi.fn()
      .mockRejectedValueOnce(new ApiTransportError('NETWORK_ERROR'))
      .mockResolvedValueOnce({ id: personalCardId });
    const coordinator = createPersonalCardPhotoCoordinator({
      createClientRequestId: () => clientRequestId,
      select,
      service: service({ upload, create }),
      isGenerationCurrent: (candidate) => candidate === current,
    });
    const input = {
      acquisitionId,
      caption: 'same caption',
      generation: current,
      onProgress: vi.fn(),
    };

    await expect(coordinator.run(input)).rejects.toMatchObject({
      failure: 'NETWORK_ERROR',
    });
    expect(photo.bytes).toEqual(new Uint8Array([0, 0, 0, 0]));
    expect(coordinator.hasPendingRetry()).toBe(true);
    await expect(coordinator.run(input)).resolves.toEqual({ id: personalCardId });
    expect(select).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenNthCalledWith(2, expect.objectContaining({
      acquisitionId,
      caption: 'same caption',
      tempPath,
    }));
  });

  it('wipes pending source bytes when the authenticated generation changes', async () => {
    const authToken = Symbol('auth');
    const first = generation(authToken, 1);
    const second = generation(authToken, 2);
    let current = first;
    const photo = selected();
    const coordinator = createPersonalCardPhotoCoordinator({
      createClientRequestId: () => clientRequestId,
      select: async () => photo,
      service: service({
        upload: async () => {
          throw new PersonalCardUploadError('NETWORK_ERROR');
        },
      }),
      isGenerationCurrent: (candidate) => candidate === current,
    });

    await expect(coordinator.run({
      acquisitionId,
      caption: '',
      generation: first,
      onProgress: vi.fn(),
    })).rejects.toBeInstanceOf(PersonalCardUploadError);
    expect(coordinator.hasPendingRetry()).toBe(true);
    current = second;
    coordinator.setGeneration(second);
    expect(coordinator.hasPendingRetry()).toBe(false);
    expect(photo.bytes).toEqual(new Uint8Array([0, 0, 0, 0]));
  });

  it('aborts and wipes a pending source selection when the user cancels', async () => {
    const current = generation(Symbol('auth'), 1);
    const photo = selected();
    let rejectUpload: ((error: Error) => void) | undefined;
    const upload = vi.fn(({ signal }: { signal?: AbortSignal }) => (
      new Promise<'uploaded'>((_resolve, reject) => {
        rejectUpload = reject;
        signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      })
    ));
    const coordinator = createPersonalCardPhotoCoordinator({
      createClientRequestId: () => clientRequestId,
      select: async () => photo,
      service: service({ upload }),
      isGenerationCurrent: (candidate) => candidate === current,
    });
    const pending = coordinator.run({
      acquisitionId,
      caption: '',
      generation: current,
      onProgress: vi.fn(),
    });
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());

    coordinator.cancelActiveAttempt();
    rejectUpload?.(new Error('aborted'));
    await expect(pending).rejects.toMatchObject({ reason: 'CANCELLED' });
    expect(photo.bytes).toEqual(new Uint8Array([0, 0, 0, 0]));
    expect(coordinator.hasPendingRetry()).toBe(false);
  });

  it('treats picker cancellation as neutral and creates no upload', async () => {
    const current = generation(Symbol('auth'), 1);
    const photoService = service();
    const coordinator = createPersonalCardPhotoCoordinator({
      createClientRequestId: () => clientRequestId,
      select: async () => null,
      service: photoService,
      isGenerationCurrent: (candidate) => candidate === current,
    });

    await expect(coordinator.run({
      acquisitionId,
      caption: '',
      generation: current,
      onProgress: vi.fn(),
    })).resolves.toBeNull();
    expect(photoService.issueUpload).not.toHaveBeenCalled();
  });
});
