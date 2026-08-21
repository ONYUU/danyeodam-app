import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const deploymentKeys = [
  "VERCEL_ENV",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ACCOUNT_DELETION_RATE_LIMIT_SECRET",
  "ACCOUNT_DELETION_SUPPORT_URL",
  "PUBLIC_SUPPORT_URL",
  "ACCOUNT_DELETION_DEVELOPER_NAME",
  "PUBLIC_APP_URL",
  "AUTH_EMAIL_REDIRECT_TO",
  "CRON_SECRET",
  "BONUS_PACK_CURSOR_SECRET",
  "COLLECTION_CURSOR_SECRET",
  "LOCATION_COMPLIANCE_CURSOR_SECRET",
  "ABUSE_HMAC_SECRET",
] as const;

function cleanEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of deploymentKeys) delete environment[key];
  return environment;
}

function completeProductionEnvironment(): NodeJS.ProcessEnv {
  return {
    ...cleanEnvironment(),
    VERCEL_ENV: "production",
    NEXT_PUBLIC_SUPABASE_URL: "https://release-fixture.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: `sb_publishable_${"p".repeat(32)}`,
    SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"s".repeat(32)}`,
    ACCOUNT_DELETION_RATE_LIMIT_SECRET: "r".repeat(32),
    ACCOUNT_DELETION_SUPPORT_URL:
      "https://support.release-fixture.danyeodam.app/account-delete",
    PUBLIC_SUPPORT_URL: "https://support.release-fixture.danyeodam.app/help",
    ACCOUNT_DELETION_DEVELOPER_NAME: "DANYEODAM",
    PUBLIC_APP_URL: "https://app.release-fixture.danyeodam.app",
    AUTH_EMAIL_REDIRECT_TO: "danyeodam://auth/callback",
    CRON_SECRET: "c".repeat(32),
    BONUS_PACK_CURSOR_SECRET: "b".repeat(32),
    COLLECTION_CURSOR_SECRET: "l".repeat(32),
    LOCATION_COMPLIANCE_CURSOR_SECRET: "o".repeat(32),
    ABUSE_HMAC_SECRET: "a".repeat(32),
  };
}

function runGate(environment: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--experimental-strip-types",
      path.join(process.cwd(), "scripts/assert-server-deployment-env.mjs"),
    ],
    { cwd: process.cwd(), encoding: "utf8", env: environment },
  );
}

describe("server deployment build environment gate", () => {
  it("is wired into both npm and Vercel builds", () => {
    const packageConfig = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    const vercelConfig = JSON.parse(readFileSync("vercel.json", "utf8")) as {
      buildCommand?: string;
    };

    expect(packageConfig.scripts?.["env:assert:deployment"]).toContain(
      "assert-server-deployment-env.mjs",
    );
    expect(packageConfig.scripts?.build).toBe(
      "npm run env:assert:deployment && next build",
    );
    expect(vercelConfig.buildCommand).toBe("npm run build");
  });

  it("keeps local and public CI builds synthetic-env independent", () => {
    const result = runGate(cleanEnvironment());
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "skipped outside Vercel preview/production",
    );
  });

  it.each(["preview", "production"] as const)(
    "fails closed before a %s build when required deployment env is absent",
    (deploymentEnvironment) => {
      const result = runGate({
        ...cleanEnvironment(),
        VERCEL_ENV: deploymentEnvironment,
      });
      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "NEXT_PUBLIC_SUPABASE_URL",
      );
    },
  );

  it("accepts a complete production environment and rejects a mutated value", () => {
    const validEnvironment = completeProductionEnvironment();
    const valid = runGate(validEnvironment);
    expect(valid.status).toBe(0);
    expect(`${valid.stdout}${valid.stderr}`).toContain(
      "Server production environment gate passed",
    );

    const mutation = runGate({
      ...validEnvironment,
      PUBLIC_SUPPORT_URL: "https://support.example.org/help",
    });
    expect(mutation.status).toBe(1);
    expect(`${mutation.stdout}${mutation.stderr}`).toContain(
      "placeholder hostname",
    );
  });
});
