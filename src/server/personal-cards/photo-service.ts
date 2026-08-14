import "server-only";

import {
  getOwnedPersonalCardPhoto,
  type OwnedPhotoResult,
} from "@/server/personal-cards/photo-repository";
import { ApiError } from "@/server/http/api-error";
import {
  downloadSharePhoto,
  type SharePhotoStream,
} from "@/server/shares/storage";

type Dependencies = {
  findOwnedPhoto(input: {
    authUserId: string;
    personalCardId: string;
  }): Promise<OwnedPhotoResult>;
  downloadPhoto(photoPath: string): Promise<SharePhotoStream>;
};

const defaultDependencies: Dependencies = {
  findOwnedPhoto: getOwnedPersonalCardPhoto,
  downloadPhoto: downloadSharePhoto,
};

export async function readOwnedPersonalCardPhoto(
  input: { authUserId: string; personalCardId: string },
  dependencies: Dependencies = defaultDependencies,
): Promise<SharePhotoStream> {
  const result = await dependencies.findOwnedPhoto(input);
  if (result.status === "unauthorized") {
    throw new ApiError("UNAUTHORIZED");
  }
  if (result.status === "not_found") {
    throw new ApiError("NOT_FOUND");
  }
  return dependencies.downloadPhoto(result.photo_path);
}
