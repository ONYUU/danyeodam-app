import "server-only";

import { createShareSlug } from "@/server/shares/code";
import {
  createPersonalCardShare,
  getPersonalCardShareStatus,
  getPublicShare,
  revokePersonalCardShare,
  type CreateShareResult,
  type PublicShareResult,
  type RevokeShareResult,
  type ShareStatusResult,
} from "@/server/shares/repository";
import { downloadSharePhoto, type SharePhotoStream } from "@/server/shares/storage";
import { ApiError } from "@/server/http/api-error";
import { publicShareUrl, requirePublicAppOrigin } from "@/server/http/public-url";
import type { LocalizedText } from "@/server/localization/schema";

export type ShareServiceDependencies = {
  createSlug(): string;
  createShare(input: {
    authUserId: string;
    publicGateOpen: boolean;
    publicShareCreationOpen: boolean;
    personalCardId: string;
    shareSlug: string | null;
    expectedUserId?: string;
  }): Promise<CreateShareResult>;
  revokeShare(input: {
    authUserId: string;
    personalCardId: string;
  }): Promise<RevokeShareResult>;
  findShareStatus(input: {
    authUserId: string;
    personalCardId: string;
  }): Promise<ShareStatusResult>;
  findPublicShare(input: {
    shareSlug: string;
    viewerAuthUserId: string | null;
    recordView: boolean;
    publicSharePublicationOpen: boolean;
  }): Promise<PublicShareResult>;
  downloadPhoto(photoPath: string): Promise<SharePhotoStream>;
};

type ShareState = "private" | "pending" | "active" | "rejected" | "taken_down";

const defaultDependencies: ShareServiceDependencies = {
  createSlug: createShareSlug,
  createShare: createPersonalCardShare,
  revokeShare: revokePersonalCardShare,
  findShareStatus: getPersonalCardShareStatus,
  findPublicShare: getPublicShare,
  downloadPhoto: downloadSharePhoto,
};

function throwShareMutationError(
  result: Extract<CreateShareResult | RevokeShareResult, {
    status:
      | "unauthorized"
      | "participant_gate_closed"
      | "share_creation_gate_closed"
      | "account_suspended"
      | "policy_required"
      | "minimum_age_attestation_required"
      | "location_consent_required"
      | "location_use_paused"
      | "location_withdrawal_pending"
      | "location_correction_pending"
      | "not_found";
  }>,
): never {
  switch (result.status) {
    case "unauthorized":
      throw new ApiError("UNAUTHORIZED");
    case "participant_gate_closed":
      throw new ApiError("GATE_CLOSED");
    case "share_creation_gate_closed":
      throw new ApiError("GATE_CLOSED", { gate: "share_creation" });
    case "account_suspended":
      throw new ApiError("ACCOUNT_SUSPENDED");
    case "policy_required":
      throw new ApiError("POLICY_ACCEPTANCE_REQUIRED", { required: result.required });
    case "not_found":
      throw new ApiError("NOT_FOUND");
    case "minimum_age_attestation_required":
      throw new ApiError("MINIMUM_AGE_ATTESTATION_REQUIRED");
    case "location_consent_required":
      throw new ApiError("LOCATION_CONSENT_REQUIRED");
    case "location_use_paused":
      throw new ApiError("LOCATION_USE_PAUSED");
    case "location_withdrawal_pending":
      throw new ApiError("LOCATION_WITHDRAWAL_PENDING");
    case "location_correction_pending":
      throw new ApiError("LOCATION_CORRECTION_PENDING");
  }
}

export async function enablePersonalCardShare(
  input: {
    authUserId: string;
    publicGateOpen: boolean;
    publicShareCreationOpen: boolean;
    personalCardId: string;
    publicAppUrl?: string;
  },
  dependencies: ShareServiceDependencies = defaultDependencies,
): Promise<{
  status: 200 | 202;
  body: { share: { slug: string; url: string; status: ShareState } };
}> {
  let expectedUserId: string | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidateSlug = input.publicShareCreationOpen ? dependencies.createSlug() : null;
    const result = await dependencies.createShare({
      authUserId: input.authUserId,
      publicGateOpen: input.publicGateOpen,
      publicShareCreationOpen: input.publicShareCreationOpen,
      personalCardId: input.personalCardId,
      shareSlug: candidateSlug,
      expectedUserId,
    });

    if (result.status === "pending" || result.status === "existing") {
      return {
        status: result.status === "pending" ? 202 : 200,
        body: {
          share: {
            slug: result.share_slug,
            url: publicShareUrl(
              requirePublicAppOrigin(input.publicAppUrl),
              result.share_slug,
            ),
            status: result.share_state,
          },
        },
      };
    }
    if (result.status !== "slug_conflict") {
      throwShareMutationError(result);
    }
    expectedUserId = result.expected_user_id;
  }

  throw new ApiError("INTERNAL");
}

export async function readPersonalCardShareStatus(
  input: {
    authUserId: string;
    personalCardId: string;
    publicAppUrl?: string;
  },
  dependencies: ShareServiceDependencies = defaultDependencies,
): Promise<{
  status: ShareState;
  slug: string | null;
  url: string | null;
  reason_code: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
}> {
  const result = await dependencies.findShareStatus(input);
  if (result.status === "unauthorized") {
    throw new ApiError("UNAUTHORIZED");
  }
  if (result.status === "not_found") {
    throw new ApiError("NOT_FOUND");
  }
  const url = result.share_slug === null
    ? null
    : publicShareUrl(requirePublicAppOrigin(input.publicAppUrl), result.share_slug);
  return {
    status: result.share_state,
    slug: result.share_slug,
    url,
    reason_code: result.reason_code,
    submitted_at: result.submitted_at,
    reviewed_at: result.reviewed_at,
  };
}

export async function disablePersonalCardShare(
  input: {
    authUserId: string;
    personalCardId: string;
  },
  dependencies: ShareServiceDependencies = defaultDependencies,
): Promise<void> {
  const result = await dependencies.revokeShare(input);
  if (result.status === "revoked" || result.status === "already_revoked") {
    return;
  }
  throwShareMutationError(result);
}

export async function readPublicShare(
  input: {
    shareSlug: string;
    viewerAuthUserId: string | null;
    publicSharePublicationOpen: boolean;
  },
  dependencies: ShareServiceDependencies = defaultDependencies,
): Promise<{
  date_kst: string;
  spot: { name: LocalizedText };
  caption: string;
  photo_available: true;
}> {
  const result = await dependencies.findPublicShare({ ...input, recordView: true });
  if (result.status === "unauthorized") {
    throw new ApiError("UNAUTHORIZED");
  }
  if (result.status === "not_found") {
    throw new ApiError("NOT_FOUND");
  }

  return {
    date_kst: result.date_kst,
    spot: result.spot,
    caption: result.caption,
    photo_available: true,
  };
}

export async function readPublicSharePhoto(
  input: {
    shareSlug: string;
    viewerAuthUserId: string | null;
    publicSharePublicationOpen: boolean;
  },
  dependencies: ShareServiceDependencies = defaultDependencies,
): Promise<SharePhotoStream> {
  const result = await dependencies.findPublicShare({ ...input, recordView: false });
  if (result.status === "unauthorized") {
    throw new ApiError("UNAUTHORIZED");
  }
  if (result.status === "not_found") {
    throw new ApiError("NOT_FOUND");
  }
  return dependencies.downloadPhoto(result.photo_path);
}
