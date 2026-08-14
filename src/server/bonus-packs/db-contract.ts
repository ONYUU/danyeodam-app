import { z } from "zod";

import { localizedTextSchema } from "@/server/localization/schema";

export const bonusPackRaritySchema = z.enum(["common", "special"]);

const internalCardSchema = z.object({
  id: z.uuid(),
  rarity: bonusPackRaritySchema,
  title: localizedTextSchema,
  asset_path: z.string().min(1).max(256),
  color_hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/u),
}).strict();

export const sealedBonusPackSchema = z.object({
  id: z.uuid(),
  status: z.literal("sealed"),
  issued_at: z.iso.datetime({ offset: true }),
  date_kst: z.iso.date(),
}).strict();

export const openedBonusPackSchema = z.object({
  id: z.uuid(),
  status: z.literal("opened"),
  issued_at: z.iso.datetime({ offset: true }),
  date_kst: z.iso.date(),
  opened_at: z.iso.datetime({ offset: true }),
  card: internalCardSchema,
}).strict();

export const bonusPackSchema = z.discriminatedUnion("status", [
  sealedBonusPackSchema,
  openedBonusPackSchema,
]);

const unauthorizedResultSchema = z.object({
  status: z.literal("unauthorized"),
}).strict();

const invalidResultSchema = z.object({
  status: z.literal("invalid"),
}).strict();

const notFoundResultSchema = z.object({
  status: z.literal("not_found"),
}).strict();

export const bonusPackListResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    items: z.array(bonusPackSchema).max(100),
    sealed_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    has_more: z.boolean(),
    next_anchor: z.object({
      issued_at: z.iso.datetime({ offset: true }),
      id: z.uuid(),
    }).strict().nullable(),
  }).strict(),
  unauthorizedResultSchema,
  invalidResultSchema,
]);

export const bonusPackDetailResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    bonus_pack: bonusPackSchema,
  }).strict(),
  unauthorizedResultSchema,
  notFoundResultSchema,
  invalidResultSchema,
]);

export const openBonusPackResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    bonus_pack: openedBonusPackSchema,
  }).strict(),
  unauthorizedResultSchema,
  notFoundResultSchema,
  z.object({ status: z.literal("idempotency_conflict") }).strict(),
  invalidResultSchema,
]);

const cardInventoryItemSchema = z.object({
  card: internalCardSchema,
  quantity: z.number().int().positive(),
  first_acquired_at: z.iso.datetime({ offset: true }),
  last_acquired_at: z.iso.datetime({ offset: true }),
}).strict();

export const cardInventoryResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    items: z.array(cardInventoryItemSchema).max(100),
    has_more: z.boolean(),
    next_anchor: z.object({
      last_acquired_at: z.iso.datetime({ offset: true }),
      card_id: z.uuid(),
    }).strict().nullable(),
  }).strict(),
  unauthorizedResultSchema,
  invalidResultSchema,
]);

export const ownedSpecialCardAssetResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("found"),
    bucket: z.literal("special-card-assets"),
    asset_path: z.string().min(1).max(256),
  }).strict(),
  unauthorizedResultSchema,
  notFoundResultSchema,
  invalidResultSchema,
]);

export type BonusPack = z.infer<typeof bonusPackSchema>;
export type SealedBonusPack = z.infer<typeof sealedBonusPackSchema>;
export type OpenedBonusPack = z.infer<typeof openedBonusPackSchema>;
export type BonusPackListResult = z.infer<typeof bonusPackListResultSchema>;
export type BonusPackDetailResult = z.infer<typeof bonusPackDetailResultSchema>;
export type OpenBonusPackResult = z.infer<typeof openBonusPackResultSchema>;
export type CardInventoryResult = z.infer<typeof cardInventoryResultSchema>;
export type OwnedSpecialCardAssetResult = z.infer<
  typeof ownedSpecialCardAssetResultSchema
>;
