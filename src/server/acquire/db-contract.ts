import { z } from "zod";

import { localizedTextSchema } from "@/server/localization/schema";

const cardSchema = z.object({
  id: z.uuid(),
  title: localizedTextSchema,
  sketch_path: z.string().min(1),
  color_hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
});

const acquisitionSchema = z.object({
  id: z.uuid(),
  spot_id: z.uuid(),
  card_id: z.uuid(),
  acquisition_type: z.literal("field"),
  acquired_at: z.iso.datetime({ offset: true }),
  acquired_on_kst: z.iso.date(),
});

const databaseErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "GATE_CLOSED",
  "NOT_FOUND",
  "SPOT_NOT_OPEN",
  "IDEMPOTENCY_CONFLICT",
  "ALREADY_ACQUIRED_TODAY",
  "MINIMUM_AGE_ATTESTATION_REQUIRED",
  "LOCATION_CONSENT_REQUIRED",
  "LOCATION_USE_PAUSED",
  "LOCATION_WITHDRAWAL_PENDING",
  "LOCATION_CORRECTION_PENDING",
  "OUT_OF_RANGE",
  "LOW_ACCURACY",
  "SPOT_CONFIG_CHANGED",
]);

const publicDetailsSchema = z.record(z.string(), z.unknown());

const databaseErrorResultSchema = z.object({
  status: z.literal("error"),
  code: databaseErrorCodeSchema,
  details: publicDetailsSchema.optional(),
  expected_user_id: z.uuid().optional(),
});

export const contextResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    user_id: z.uuid(),
    spot: z.object({
      id: z.uuid(),
      latitude: z.number().finite().min(-90).max(90),
      longitude: z.number().finite().min(-180).max(180),
      radius_m: z.number().int().positive(),
      accuracy_threshold_m: z.number().int().positive(),
      updated_at: z.iso.datetime({ offset: true }),
    }),
    card: cardSchema,
  }),
  z.object({
    status: z.literal("replay"),
    acquisition: acquisitionSchema,
    card: cardSchema,
  }),
  databaseErrorResultSchema,
]);

export const commitResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("created"),
    acquisition: acquisitionSchema,
    card: cardSchema,
  }),
  z.object({
    status: z.literal("replay"),
    acquisition: acquisitionSchema,
    card: cardSchema,
  }),
  databaseErrorResultSchema,
]);

export const recordFailureResultSchema = z.union([
  z.object({
    status: z.literal("failed"),
    code: z.literal("LOW_ACCURACY"),
    details: z.object({ retry: z.literal(true) }).strict(),
  }),
  z.object({
    status: z.literal("failed"),
    code: z.literal("OUT_OF_RANGE"),
    details: z.object({ distance_band: z.enum(["near", "far"]) }).strict(),
  }),
  z.object({
    status: z.literal("failed"),
    code: z.enum(["ALREADY_ACQUIRED_TODAY", "SPOT_NOT_OPEN", "GATE_CLOSED"]),
    details: z.object({}).strict(),
  }),
  z.object({
    status: z.literal("replay"),
    acquisition: acquisitionSchema,
    card: cardSchema,
  }),
  databaseErrorResultSchema,
]);
