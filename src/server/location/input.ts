import { z } from "zod";

import { supportedLocales } from "@/server/localization/schema";
import { ApiError } from "@/server/http/api-error";

const localeSchema = z.enum(supportedLocales);
const consentInputSchema = z.object({
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  locale: localeSchema,
}).strict();
const stateInputSchema = z.object({ state: z.enum(["active", "paused"]) }).strict();
const correctionReasonSchema = z.enum([
  "not_my_visit",
  "wrong_spot",
  "incorrect_outcome",
  "other",
]);
const correctionInputSchema = z.union([
  z.object({
    location_use_fact_id: z.number().int().positive(),
    client_request_id: z.uuid(),
    reason: correctionReasonSchema,
  }).strict(),
  z.object({
    field_acquisition_id: z.uuid(),
    client_request_id: z.uuid(),
    reason: correctionReasonSchema,
  }).strict(),
]);
const adminResolutionInputSchema = z.object({
  resolution: z.enum(["accepted", "rejected"]),
}).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError("VALIDATION_FAILED");
  return result.data;
}

export type LocationConsentInput = z.infer<typeof consentInputSchema>;
export type LocationConsentStateInput = z.infer<typeof stateInputSchema>;
export type LocationCorrectionInput = z.infer<typeof correctionInputSchema>;
export type LocationCorrectionResolutionInput = z.infer<typeof adminResolutionInputSchema>;

export const parseLocationConsentInput = (value: unknown): LocationConsentInput =>
  parse(consentInputSchema, value);
export const parseLocationConsentStateInput = (value: unknown): LocationConsentStateInput =>
  parse(stateInputSchema, value);
export const parseLocationCorrectionInput = (value: unknown): LocationCorrectionInput =>
  parse(correctionInputSchema, value);
export const parseLocationCorrectionResolutionInput = (
  value: unknown,
): LocationCorrectionResolutionInput => parse(adminResolutionInputSchema, value);

export function parseLocationCorrectionRequestId(value: string): string {
  return parse(z.uuid(), value);
}
