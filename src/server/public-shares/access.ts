import "server-only";

import {
  getServerEnvironment,
  isPublicSharePublicationOpen,
} from "@/server/env";
import { ApiError } from "@/server/http/api-error";
import { requireAgeAttestation } from "@/server/public-shares/age-attestation";

export function requirePublicShareAccess(request: Request): {
  publicSharePublicationOpen: true;
} {
  const environment = getServerEnvironment();
  if (!isPublicSharePublicationOpen(environment.PUBLIC_SHARE_PUBLICATION)) {
    throw new ApiError("NOT_FOUND");
  }
  requireAgeAttestation(request, environment.ABUSE_HMAC_SECRET);
  return { publicSharePublicationOpen: true };
}
