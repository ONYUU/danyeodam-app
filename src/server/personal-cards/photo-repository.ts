import "server-only";

import { z } from "zod";

import { getServiceClient } from "@/server/supabase/service";

const ownedPhotoResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("found"),
    photo_path: z.string().min(1).max(256),
  }).strict(),
  z.object({ status: z.literal("unauthorized") }).strict(),
  z.object({ status: z.literal("not_found") }).strict(),
]);

export type OwnedPhotoResult = z.infer<typeof ownedPhotoResultSchema>;

export class PersonalCardPhotoRepositoryError extends Error {
  constructor() {
    super("Personal card photo repository operation failed");
    this.name = "PersonalCardPhotoRepositoryError";
  }
}

export async function getOwnedPersonalCardPhoto(input: {
  authUserId: string;
  personalCardId: string;
}): Promise<OwnedPhotoResult> {
  const { data, error } = await getServiceClient()
    .schema("api_private")
    .rpc("get_owned_personal_card_photo", {
      p_auth_user_id: input.authUserId,
      p_personal_card_id: input.personalCardId,
    });
  if (error !== null) {
    throw new PersonalCardPhotoRepositoryError();
  }
  return ownedPhotoResultSchema.parse(data);
}
