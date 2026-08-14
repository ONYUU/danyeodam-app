import "server-only";

import { z } from "zod";

import type { ContentReportInput } from "@/server/reports/input";
import { getServiceClient } from "@/server/supabase/service";

const contentReportResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("received"),
    report_id: z.uuid(),
    duplicate: z.boolean(),
  }).strict(),
  z.object({ status: z.literal("invalid") }).strict(),
  z.object({ status: z.literal("not_found") }).strict(),
  z.object({ status: z.literal("idempotency_conflict") }).strict(),
  z.object({
    status: z.literal("rate_limited"),
    retry_after_seconds: z.number().int().min(1).max(3600),
  }).strict(),
]);

export type ContentReportResult = z.infer<typeof contentReportResultSchema>;

export class ContentReportRepositoryError extends Error {
  constructor() {
    super("Content report repository operation failed");
    this.name = "ContentReportRepositoryError";
  }
}

export async function createContentReport(input: {
  shareSlug: string;
  report: ContentReportInput;
  reporterKeyHash: string;
  publicSharePublicationOpen: boolean;
}): Promise<ContentReportResult> {
  const { data, error } = await getServiceClient()
    .schema("api_private")
    .rpc("create_content_report", {
      p_share_slug: input.shareSlug,
      p_client_report_id: input.report.client_report_id,
      p_target: input.report.target,
      p_reason: input.report.reason,
      p_comment: input.report.comment ?? null,
      p_reporter_key_hash_hex: input.reporterKeyHash,
      p_public_share_publication_open: input.publicSharePublicationOpen,
    });
  if (error !== null) {
    throw new ContentReportRepositoryError();
  }
  return contentReportResultSchema.parse(data);
}
