import "server-only";

import { z } from "zod";

const optionalEnvironmentString = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    schema.optional(),
  );

const authEmailRedirectSchema = z.url().superRefine((value, context) => {
  const url = new URL(value);
  const isLocalHttp = url.protocol === "http:"
    && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && url.protocol !== "danyeodam:" && !isLocalHttp) {
    context.addIssue({
      code: "custom",
      message: "AUTH_EMAIL_REDIRECT_TO must use HTTPS, the danyeodam scheme, or loopback HTTP",
    });
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    context.addIssue({
      code: "custom",
      message: "AUTH_EMAIL_REDIRECT_TO cannot include credentials or a fragment",
    });
  }
});

const httpsUrlSchema = z.url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    context.addIssue({
      code: "custom",
      message: "Public support URLs must use HTTPS",
    });
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    context.addIssue({
      code: "custom",
      message: "Public support URLs cannot include credentials or a fragment",
    });
  }
});

const publicAppUrlSchema = httpsUrlSchema.superRefine((value, context) => {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search !== "") {
    context.addIssue({
      code: "custom",
      message: "PUBLIC_APP_URL must be an HTTPS origin without a path or query",
    });
  }
});

const serverEnvironmentSchema = z.object({
  VERCEL_ENV: z.enum(["development", "preview", "production"]).optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  PUBLIC_RECRUIT_GATE: z.string().optional(),
  PUBLIC_SHARE_CREATION: z.string().optional(),
  PUBLIC_SHARE_PUBLICATION: z.string().optional(),
  PUBLIC_APP_URL: optionalEnvironmentString(publicAppUrlSchema),
  COLLECTION_CURSOR_SECRET: optionalEnvironmentString(z.string().min(32)),
  LOCATION_COMPLIANCE_CURSOR_SECRET: optionalEnvironmentString(z.string().min(32)),
  ABUSE_HMAC_SECRET: optionalEnvironmentString(z.string().min(32)),
  ACCOUNT_DELETION_RATE_LIMIT_SECRET: optionalEnvironmentString(z.string().min(32)),
  ACCOUNT_DELETION_SUPPORT_URL: optionalEnvironmentString(httpsUrlSchema),
  PUBLIC_SUPPORT_URL: optionalEnvironmentString(httpsUrlSchema),
  ACCOUNT_DELETION_DEVELOPER_NAME: optionalEnvironmentString(
    z.string().trim().min(1).max(120),
  ),
  AUTH_EMAIL_REDIRECT_TO: authEmailRedirectSchema,
  CRON_SECRET: optionalEnvironmentString(z.string().min(32)),
}).superRefine((environment, context) => {
  if (
    environment.VERCEL_ENV !== "preview"
    && environment.VERCEL_ENV !== "production"
  ) return;

  const requiredAccountDeletionKeys = [
    "ACCOUNT_DELETION_RATE_LIMIT_SECRET",
    "ACCOUNT_DELETION_SUPPORT_URL",
    "PUBLIC_SUPPORT_URL",
    "ACCOUNT_DELETION_DEVELOPER_NAME",
    "PUBLIC_APP_URL",
    "CRON_SECRET",
  ] as const;
  for (const key of requiredAccountDeletionKeys) {
    if (environment[key] === undefined) {
      context.addIssue({
        code: "custom",
        path: [key],
        message: `${key} is required for the production account-deletion SLA`,
      });
    }
  }
});

export type ServerEnvironment = z.infer<typeof serverEnvironmentSchema>;

let cachedEnvironment: ServerEnvironment | undefined;

export function getServerEnvironment(): ServerEnvironment {
  cachedEnvironment ??= serverEnvironmentSchema.parse(process.env);
  return cachedEnvironment;
}

export function isPublicRecruitmentOpen(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isPublicShareCreationOpen(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isPublicSharePublicationOpen(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}
