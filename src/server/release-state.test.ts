import { describe, expect, it } from "vitest";

import { buildPublicReleaseState } from "@/server/release-state";

const productionSystemEnvironment = {
  VERCEL_ENV: "production",
  VERCEL_TARGET_ENV: "production",
  VERCEL_DEPLOYMENT_ID: `dpl_${"A".repeat(28)}`,
  VERCEL_PROJECT_ID: `prj_${"B".repeat(28)}`,
  VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
};

describe("public release state", () => {
  it("projects only non-secret runtime rollout facts from the exact production deployment", () => {
    expect(buildPublicReleaseState({
      PUBLIC_RECRUIT_GATE: " TRUE ",
      PUBLIC_SHARE_CREATION: "true",
      PUBLIC_SHARE_PUBLICATION: "false",
      BONUS_PACK_ISSUANCE_SCOPE: "participants",
    }, productionSystemEnvironment)).toEqual({
      schemaVersion: 1,
      vercelEnvironment: "production",
      vercelTargetEnvironment: "production",
      deploymentId: productionSystemEnvironment.VERCEL_DEPLOYMENT_ID,
      projectId: productionSystemEnvironment.VERCEL_PROJECT_ID,
      sourceCommitSha: productionSystemEnvironment.VERCEL_GIT_COMMIT_SHA,
      publicRecruitGate: true,
      bonusPackIssuanceScope: "participants",
      publicShareCreation: true,
      publicSharePublication: false,
    });
  });

  it.each([
    [{ ...productionSystemEnvironment, VERCEL_ENV: "preview" }],
    [{ ...productionSystemEnvironment, VERCEL_TARGET_ENV: "preview" }],
    [{ ...productionSystemEnvironment, VERCEL_DEPLOYMENT_ID: undefined }],
    [{ ...productionSystemEnvironment, VERCEL_PROJECT_ID: "project-name" }],
    [{ ...productionSystemEnvironment, VERCEL_GIT_COMMIT_SHA: "A".repeat(40) }],
  ])("fails closed outside an attributable production deployment", (systemEnvironment) => {
    expect(() => buildPublicReleaseState({
      PUBLIC_RECRUIT_GATE: "true",
      PUBLIC_SHARE_CREATION: "true",
      PUBLIC_SHARE_PUBLICATION: "true",
      BONUS_PACK_ISSUANCE_SCOPE: "public",
    }, systemEnvironment)).toThrow();
  });
});
