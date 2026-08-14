import {
  closeNativeBlobIfSupported,
  createOwnedPhotoResource,
  releaseOwnedPhotoResource,
  type OwnedPhotoResource,
} from './owned-photo-resource';

export type OwnedPhotoLoadAttempt = {
  readonly signal: AbortSignal;
  publish(blob: Blob): OwnedPhotoResource | null;
  release(): void;
};

export function createOwnedPhotoLoadAttempt(dependencies: {
  createResource?(blob: Blob): OwnedPhotoResource;
  releaseResource?(resource: OwnedPhotoResource): void;
} = {}): OwnedPhotoLoadAttempt {
  const controller = new AbortController();
  const createResource = dependencies.createResource ?? createOwnedPhotoResource;
  const releaseResource = dependencies.releaseResource ?? releaseOwnedPhotoResource;
  let ownedResource: OwnedPhotoResource | null = null;

  return {
    signal: controller.signal,
    publish(blob) {
      if (controller.signal.aborted) {
        closeNativeBlobIfSupported(blob);
        return null;
      }
      const resource = createResource(blob);
      if (controller.signal.aborted) {
        releaseResource(resource);
        return null;
      }
      ownedResource = resource;
      return resource;
    },
    release() {
      controller.abort();
      if (ownedResource !== null) {
        releaseResource(ownedResource);
        ownedResource = null;
      }
    },
  };
}
