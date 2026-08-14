import { z } from "zod";

import { ApiError } from "@/server/http/api-error";
import { supportedLocales } from "@/server/localization/schema";

const acceptanceSchema = z.object({
  type: z.enum(["terms_of_use", "community_guidelines"]),
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  locale: z.enum(supportedLocales),
}).strict();

const policyAcceptanceInputSchema = z.object({
  acceptances: z.array(acceptanceSchema).length(2),
}).strict().superRefine((value, context) => {
  const types = new Set(value.acceptances.map((acceptance) => acceptance.type));
  if (types.size !== 2) {
    context.addIssue({
      code: "custom",
      message: "Each required policy type must be accepted exactly once",
      path: ["acceptances"],
    });
  }
});

export type PolicyAcceptanceInput = z.infer<typeof policyAcceptanceInputSchema>;

export function parsePolicyAcceptanceInput(value: unknown): PolicyAcceptanceInput {
  const result = policyAcceptanceInputSchema.safeParse(value);
  if (!result.success) {
    throw new ApiError("VALIDATION_FAILED");
  }
  return result.data;
}
