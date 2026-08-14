import { z } from "zod";

import { localizedTextSchema } from "@/server/localization/schema";

const publicCardSchema = z.object({
  id: z.uuid(),
  title: localizedTextSchema,
  sketch_path: z.string().min(1).max(256),
  color_hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/u),
}).strict();

const publicSpotSchema = z.object({
  id: z.uuid(),
  slug: z.string().min(1).max(128),
  name: localizedTextSchema,
  region: z.object({
    code: z.string().min(1).max(64),
    name: localizedTextSchema,
  }).strict(),
  status: z.enum(["open", "teaser"]),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  card: publicCardSchema.nullable(),
}).strict();

export const publicSpotsResultSchema = z.object({
  content_version: z.iso.datetime({ offset: true }),
  spots: z.array(publicSpotSchema),
}).strict();

export type PublicSpotsResult = z.infer<typeof publicSpotsResultSchema>;
