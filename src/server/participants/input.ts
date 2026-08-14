import { z } from "zod";

import { ApiError } from "@/server/http/api-error";

const inviteCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

const redeemInputSchema = z.object({
  invite_code: inviteCodeSchema,
}).strict();

const issueInputSchema = z.object({
  count: z.number().int().min(1).max(20),
  note: z.string().trim().min(1).max(200).optional(),
}).strict();

export type RedeemParticipantInput = z.infer<typeof redeemInputSchema>;
export type IssueParticipantInvitesInput = z.infer<typeof issueInputSchema>;

function parseWith<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError("VALIDATION_FAILED");
  }
  return result.data;
}

export function parseRedeemParticipantInput(value: unknown): RedeemParticipantInput {
  return parseWith(redeemInputSchema, value);
}

export function parseIssueParticipantInvitesInput(value: unknown): IssueParticipantInvitesInput {
  return parseWith(issueInputSchema, value);
}
