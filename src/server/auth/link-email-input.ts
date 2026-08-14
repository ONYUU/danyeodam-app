import { z } from "zod";

import { ApiError } from "@/server/http/api-error";

const pkceFlowIdSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
);

const s256CodeChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

const linkEmailInputSchema = z.object({
  email: z.email().max(254).transform((email) => email.toLowerCase()),
  flow_id: pkceFlowIdSchema,
  code_challenge: s256CodeChallengeSchema,
  code_challenge_method: z.literal("s256"),
}).strict();

export type LinkEmailInput = z.infer<typeof linkEmailInputSchema>;

export function parseLinkEmailInput(value: unknown): LinkEmailInput {
  const result = linkEmailInputSchema.safeParse(value);
  if (!result.success) {
    throw new ApiError("VALIDATION_FAILED");
  }
  return result.data;
}
