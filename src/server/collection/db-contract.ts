import { z } from "zod";

import { localizedTextSchema } from "@/server/localization/schema";

const acquisitionTypeSchema = z.enum(["field", "retro", "gift"]);
const shareStateSchema = z.enum([
  "private",
  "pending",
  "active",
  "rejected",
  "taken_down",
]);

const collectionItemSchema = z.object({
  acquisition: z.object({
    id: z.uuid(),
    spot_id: z.uuid(),
    card_id: z.uuid(),
    type: acquisitionTypeSchema,
    acquired_at: z.iso.datetime({ offset: true }),
    date_kst: z.iso.date(),
  }).strict(),
  spot: z.object({
    slug: z.string().min(1).max(128),
    name: localizedTextSchema,
  }).strict(),
  card: z.object({
    title: localizedTextSchema,
    sketch_path: z.string().min(1).max(256),
    color_hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/u),
  }).strict(),
  personal_card: z.object({
    id: z.uuid(),
    caption: z.string().max(60),
    photo_path: z.string().min(1).max(256),
    created_at: z.iso.datetime({ offset: true }),
    share_status: shareStateSchema,
    share_slug: z.string().regex(/^[A-Za-z0-9]{22,128}$/u).nullable(),
    reason_code: z.string().regex(/^[A-Z0-9_]{1,64}$/u).nullable(),
  }).strict().nullable(),
}).strict();

export const collectionResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    items: z.array(collectionItemSchema).max(100),
    has_more: z.boolean(),
    next_anchor: z.object({
      acquired_at: z.iso.datetime({ offset: true }),
      id: z.uuid(),
    }).strict().nullable(),
    stats: z.object({
      total_acquisitions: z.number().int().nonnegative(),
      spots_visited: z.number().int().nonnegative(),
      personal_cards: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
  z.object({ status: z.literal("unauthorized") }).strict(),
  z.object({ status: z.literal("invalid") }).strict(),
]);

export type CollectionResult = z.infer<typeof collectionResultSchema>;
