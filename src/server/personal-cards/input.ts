import { z } from "zod";

import { ApiError } from "@/server/http/api-error";

export const personalCardContentTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type PersonalCardContentType = (typeof personalCardContentTypes)[number];

export const MAX_PERSONAL_CARD_SOURCE_BYTES = 10 * 1024 * 1024;

const uploadInputSchema = z
  .object({
    content_type: z.enum(personalCardContentTypes),
    size: z.number().int().min(1).max(MAX_PERSONAL_CARD_SOURCE_BYTES),
    client_request_id: z.uuid(),
  })
  .strict();

const deletionInputSchema = z
  .object({
    client_request_id: z.uuid(),
  })
  .strict();

const ownedTemporaryPathSchema = z
  .string()
  .max(128)
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/i,
  );

const promotionInputSchema = z
  .object({
    acquisition_id: z.uuid(),
    temp_path: ownedTemporaryPathSchema,
    caption: z.string().max(60).default(""),
  })
  .strict();

export type PersonalCardUploadInput = z.infer<typeof uploadInputSchema>;
export type PersonalCardPromotionInput = z.infer<typeof promotionInputSchema>;
export type PersonalCardDeletionInput = z.infer<typeof deletionInputSchema>;

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError("VALIDATION_FAILED");
  }
  return result.data;
}

export function parsePersonalCardUploadInput(value: unknown): PersonalCardUploadInput {
  return parseOrThrow(uploadInputSchema, value);
}

export function parsePersonalCardPromotionInput(value: unknown): PersonalCardPromotionInput {
  return parseOrThrow(promotionInputSchema, value);
}

export function parsePersonalCardDeletionInput(value: unknown): PersonalCardDeletionInput {
  return parseOrThrow(deletionInputSchema, value);
}
