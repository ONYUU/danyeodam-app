import { z } from "zod";

import { ApiError } from "@/server/http/api-error";

const appUserIdSchema = z.uuid();
const clientActionIdSchema = z.uuid();

const provisionSchema = z.object({
  app_user_id: appUserIdSchema,
  store_platform: z.enum(["app_store", "play_store"]),
  fixture_version: z.string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
  client_action_id: clientActionIdSchema,
}).strict();

const lifecycleActionSchema = z.object({
  client_action_id: clientActionIdSchema,
}).strict();

export type ReviewerProvisionInput = z.infer<typeof provisionSchema>;
export type ReviewerLifecycleActionInput = z.infer<typeof lifecycleActionSchema>;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError("VALIDATION_FAILED");
  return parsed.data;
}

export function parseReviewerProvisionInput(value: unknown): ReviewerProvisionInput {
  return parse(provisionSchema, value);
}

export function parseReviewerLifecycleActionInput(
  value: unknown,
): ReviewerLifecycleActionInput {
  return parse(lifecycleActionSchema, value);
}

export function parseReviewerAppUserId(value: string): string {
  const parsed = appUserIdSchema.safeParse(value);
  if (!parsed.success) throw new ApiError("NOT_FOUND");
  return parsed.data;
}
