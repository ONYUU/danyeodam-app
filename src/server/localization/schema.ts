import { z } from "zod";

export const supportedLocales = [
  "ko",
  "en",
  "ja",
  "zh-Hans",
  "zh-Hant",
  "vi",
] as const;

export const localizedTextSchema = z.object({
  ko: z.string().min(1),
  en: z.string().min(1),
  ja: z.string().min(1),
  "zh-Hans": z.string().min(1),
  "zh-Hant": z.string().min(1),
  vi: z.string().min(1),
}).strict();

export type LocalizedText = z.infer<typeof localizedTextSchema>;
