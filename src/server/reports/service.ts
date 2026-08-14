import "server-only";

import { ApiError } from "@/server/http/api-error";
import {
  createContentReport,
  type ContentReportResult,
} from "@/server/reports/repository";
import type { ContentReportInput } from "@/server/reports/input";

export type ContentReportServiceDependencies = {
  create(input: {
    shareSlug: string;
    report: ContentReportInput;
    reporterKeyHash: string;
    publicSharePublicationOpen: boolean;
  }): Promise<ContentReportResult>;
};

const defaultDependencies: ContentReportServiceDependencies = {
  create: createContentReport,
};

export async function submitContentReport(
  input: {
    shareSlug: string;
    report: ContentReportInput;
    reporterKeyHash: string;
    publicSharePublicationOpen: boolean;
  },
  dependencies: ContentReportServiceDependencies = defaultDependencies,
): Promise<{ id: string }> {
  const result = await dependencies.create(input);
  switch (result.status) {
    case "received":
      return { id: result.report_id };
    case "invalid":
      throw new ApiError("VALIDATION_FAILED");
    case "not_found":
      throw new ApiError("NOT_FOUND");
    case "idempotency_conflict":
      throw new ApiError("IDEMPOTENCY_CONFLICT");
    case "rate_limited":
      throw new ApiError("RATE_LIMITED", {
        retry_after_seconds: result.retry_after_seconds,
      });
  }
}
