import { closeNativeBlobIfSupported } from '@/api/native-blob';

export { closeNativeBlobIfSupported } from '@/api/native-blob';

export type OwnedPhotoResource = {
  blob: Blob;
  objectUrl: string;
};

export function createOwnedPhotoResource(
  blob: Blob,
  createObjectUrl: (value: Blob) => string = URL.createObjectURL,
): OwnedPhotoResource {
  try {
    return { blob, objectUrl: createObjectUrl(blob) };
  } catch (error) {
    closeNativeBlobIfSupported(blob);
    throw error;
  }
}

export function releaseOwnedPhotoResource(
  resource: OwnedPhotoResource,
  revokeObjectUrl: (value: string) => void = URL.revokeObjectURL,
): void {
  revokeObjectUrl(resource.objectUrl);
  closeNativeBlobIfSupported(resource.blob);
}
