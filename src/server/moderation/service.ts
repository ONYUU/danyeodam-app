import "server-only";

import { ApiError } from "@/server/http/api-error";
import type {
  ReportModerationActionInput,
  ShareModerationActionInput,
  SuspensionModerationActionInput,
} from "@/server/moderation/input";
import {
  getModerationSharePhoto,
  listContentReports,
  listShareModerationQueue,
  listShareOwnerSuspensions,
  moderateContentReport,
  moderatePersonalCardShare,
  moderateShareOwnerSuspension,
  type ModerationPhotoResult,
  type ReportActionResult,
  type ReportQueueResult,
  type ShareActionResult,
  type ShareQueueResult,
  type SuspensionActionResult,
  type SuspensionQueueResult,
} from "@/server/moderation/repository";
import { downloadSharePhoto, type SharePhotoStream } from "@/server/shares/storage";

export type ModerationServiceDependencies = {
  listShares(input: { authUserId: string; status: string; limit: number }): Promise<ShareQueueResult>;
  findPhoto(input: { authUserId: string; personalCardId: string }): Promise<ModerationPhotoResult>;
  applyShareAction(input: {
    authUserId: string;
    personalCardId: string;
    action: ShareModerationActionInput;
    publicSharePublicationOpen: boolean;
  }): Promise<ShareActionResult>;
  listReports(input: { authUserId: string; status: string; limit: number }): Promise<ReportQueueResult>;
  applyReportAction(input: {
    authUserId: string;
    reportId: string;
    action: ReportModerationActionInput;
  }): Promise<ReportActionResult>;
  listSuspensions(input: {
    authUserId: string;
    status: string;
    limit: number;
  }): Promise<SuspensionQueueResult>;
  applySuspensionAction(input: {
    authUserId: string;
    suspensionId: string;
    action: SuspensionModerationActionInput;
  }): Promise<SuspensionActionResult>;
  downloadPhoto(path: string): Promise<SharePhotoStream>;
};

const defaultDependencies: ModerationServiceDependencies = {
  listShares: listShareModerationQueue,
  findPhoto: getModerationSharePhoto,
  applyShareAction: moderatePersonalCardShare,
  listReports: listContentReports,
  applyReportAction: moderateContentReport,
  listSuspensions: listShareOwnerSuspensions,
  applySuspensionAction: moderateShareOwnerSuspension,
  downloadPhoto: downloadSharePhoto,
};

function throwCommon(result: { status: string; reason?: string }): never {
  switch (result.status) {
    case "unauthorized": throw new ApiError("UNAUTHORIZED");
    case "forbidden": throw new ApiError("FORBIDDEN");
    case "invalid": throw new ApiError("VALIDATION_FAILED");
    case "not_found": throw new ApiError("NOT_FOUND");
    case "idempotency_conflict": throw new ApiError("IDEMPOTENCY_CONFLICT");
    case "publication_gate_closed": throw new ApiError("GATE_CLOSED", {
      gate: "share_publication",
    });
    case "conflict": throw new ApiError("MODERATION_CONFLICT", { reason: result.reason });
    case "minimum_age_attestation_required":
      throw new ApiError("MINIMUM_AGE_ATTESTATION_REQUIRED");
    case "location_consent_required": throw new ApiError("LOCATION_CONSENT_REQUIRED");
    case "location_use_paused": throw new ApiError("LOCATION_USE_PAUSED");
    case "location_withdrawal_pending": throw new ApiError("LOCATION_WITHDRAWAL_PENDING");
    case "location_correction_pending": throw new ApiError("LOCATION_CORRECTION_PENDING");
    default: throw new ApiError("INTERNAL");
  }
}

export async function readShareModerationQueue(
  input: { authUserId: string; status: string; limit: number },
  dependencies: ModerationServiceDependencies = defaultDependencies,
) {
  const result = await dependencies.listShares(input);
  if (result.status !== "ready") throwCommon(result);
  return result.items.map((item) => ({
    ...item,
    photo_url: `/api/admin/moderation/shares/${encodeURIComponent(item.id)}/photo`,
  }));
}

export async function readModerationSharePhoto(
  input: { authUserId: string; personalCardId: string },
  dependencies: ModerationServiceDependencies = defaultDependencies,
): Promise<SharePhotoStream> {
  const result = await dependencies.findPhoto(input);
  if (result.status !== "found") throwCommon(result);
  return dependencies.downloadPhoto(result.photo_path);
}

export async function applyShareModerationAction(
  input: {
    authUserId: string;
    personalCardId: string;
    action: ShareModerationActionInput;
    publicSharePublicationOpen: boolean;
  },
  dependencies: ModerationServiceDependencies = defaultDependencies,
): Promise<{ status: "applied" | "duplicate"; share_state: string; affected: number }> {
  const result = await dependencies.applyShareAction(input);
  if (result.status !== "applied" && result.status !== "duplicate") throwCommon(result);
  return result;
}

export async function readContentReportQueue(
  input: { authUserId: string; status: string; limit: number },
  dependencies: ModerationServiceDependencies = defaultDependencies,
) {
  const result = await dependencies.listReports(input);
  if (result.status !== "ready") throwCommon(result);
  return result.items;
}

export async function applyContentReportAction(
  input: { authUserId: string; reportId: string; action: ReportModerationActionInput },
  dependencies: ModerationServiceDependencies = defaultDependencies,
): Promise<{ status: "applied" | "duplicate" }> {
  const result = await dependencies.applyReportAction(input);
  if (result.status !== "applied" && result.status !== "duplicate") throwCommon(result);
  return result;
}

export async function readShareOwnerSuspensions(
  input: { authUserId: string; status: string; limit: number },
  dependencies: ModerationServiceDependencies = defaultDependencies,
) {
  const result = await dependencies.listSuspensions(input);
  if (result.status !== "ready") throwCommon(result);
  return result.items;
}

export async function applyShareOwnerSuspensionAction(
  input: {
    authUserId: string;
    suspensionId: string;
    action: SuspensionModerationActionInput;
  },
  dependencies: ModerationServiceDependencies = defaultDependencies,
): Promise<{ status: "applied" | "duplicate" }> {
  const result = await dependencies.applySuspensionAction(input);
  if (result.status !== "applied" && result.status !== "duplicate") throwCommon(result);
  return result;
}
