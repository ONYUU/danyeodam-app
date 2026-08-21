import { z } from "zod";

import {
  getServerEnvironment,
  isPublicRecruitmentOpen,
  isPublicShareCreationOpen,
  isPublicSharePublicationOpen,
  type ServerEnvironment,
} from "@/server/env";

const vercelReleaseEnvironmentSchema = z.object({
  VERCEL_ENV: z.literal("production"),
  VERCEL_TARGET_ENV: z.literal("production"),
  VERCEL_DEPLOYMENT_ID: z.string().regex(/^dpl_[A-Za-z0-9]{20,}$/u),
  VERCEL_PROJECT_ID: z.string().regex(/^prj_[A-Za-z0-9]{20,}$/u),
  VERCEL_GIT_COMMIT_SHA: z.string().regex(/^[a-f0-9]{40}$/u),
});

type ReleaseFeatureEnvironment = Pick<
  ServerEnvironment,
  | "PUBLIC_RECRUIT_GATE"
  | "PUBLIC_SHARE_CREATION"
  | "PUBLIC_SHARE_PUBLICATION"
  | "BONUS_PACK_ISSUANCE_SCOPE"
>;

export interface PublicReleaseState extends Record<string, unknown> {
  schemaVersion: 1;
  vercelEnvironment: "production";
  vercelTargetEnvironment: "production";
  deploymentId: string;
  projectId: string;
  sourceCommitSha: string;
  publicRecruitGate: boolean;
  bonusPackIssuanceScope: "off" | "participants" | "public";
  publicShareCreation: boolean;
  publicSharePublication: boolean;
}

export function buildPublicReleaseState(
  environment: ReleaseFeatureEnvironment,
  systemEnvironment: Readonly<Record<string, string | undefined>>,
): PublicReleaseState {
  const vercel = vercelReleaseEnvironmentSchema.parse({
    VERCEL_ENV: systemEnvironment.VERCEL_ENV,
    VERCEL_TARGET_ENV: systemEnvironment.VERCEL_TARGET_ENV,
    VERCEL_DEPLOYMENT_ID: systemEnvironment.VERCEL_DEPLOYMENT_ID,
    VERCEL_PROJECT_ID: systemEnvironment.VERCEL_PROJECT_ID,
    VERCEL_GIT_COMMIT_SHA: systemEnvironment.VERCEL_GIT_COMMIT_SHA,
  });

  return {
    schemaVersion: 1,
    vercelEnvironment: vercel.VERCEL_ENV,
    vercelTargetEnvironment: vercel.VERCEL_TARGET_ENV,
    deploymentId: vercel.VERCEL_DEPLOYMENT_ID,
    projectId: vercel.VERCEL_PROJECT_ID,
    sourceCommitSha: vercel.VERCEL_GIT_COMMIT_SHA,
    publicRecruitGate: isPublicRecruitmentOpen(environment.PUBLIC_RECRUIT_GATE),
    bonusPackIssuanceScope: environment.BONUS_PACK_ISSUANCE_SCOPE,
    publicShareCreation: isPublicShareCreationOpen(environment.PUBLIC_SHARE_CREATION),
    publicSharePublication: isPublicSharePublicationOpen(
      environment.PUBLIC_SHARE_PUBLICATION,
    ),
  };
}

export function readPublicReleaseState(): PublicReleaseState {
  return buildPublicReleaseState(getServerEnvironment(), process.env);
}
