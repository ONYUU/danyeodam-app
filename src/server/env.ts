import "server-only";

import { z } from "zod";

const PUBLIC_DEPLOYMENT_ENVIRONMENTS = new Set(["preview", "production"]);
const RESERVED_PUBLIC_HOST_SUFFIXES = [
  ".invalid",
  ".example",
  ".test",
  ".localhost",
  ".internal",
  ".alt",
  ".onion",
] as const;
const PLACEHOLDER_PUBLIC_HOSTS = [
  "example.com",
  "example.net",
  "example.org",
  "home.arpa",
] as const;

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

function parseIpv4(hostname: string): number[] | null {
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d+$/u.test(octet))) {
    return null;
  }

  const numbers = octets.map(Number);
  return numbers.some((octet) => octet < 0 || octet > 255) ? null : numbers;
}

function parseIpv6(hostname: string): number[] | null {
  if (!hostname.includes(":")) return null;
  const halves = hostname.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const right = halves.length === 1 || halves[1] === ""
    ? []
    : (halves[1] ?? "").split(":");
  const explicitGroups = [...left, ...right];
  if (explicitGroups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) {
    return null;
  }
  const omittedGroupCount = 8 - explicitGroups.length;
  if (
    (halves.length === 1 && omittedGroupCount !== 0)
    || (halves.length === 2 && omittedGroupCount < 1)
  ) {
    return null;
  }
  return [
    ...left.map((group) => Number.parseInt(group, 16)),
    ...Array.from({ length: omittedGroupCount }, () => 0),
    ...right.map((group) => Number.parseInt(group, 16)),
  ];
}

function ipv4FromIpv6Tail(ipv6: number[]): string {
  const high = ipv6[6] ?? 0;
  const low = ipv6[7] ?? 0;
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

function isNonPublicHostname(rawHostname: string): boolean {
  const hostname = rawHostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");

  if (
    hostname === "invalid"
    || hostname === "example"
    || hostname === "test"
    || hostname === "localhost"
    || hostname === "local"
    || hostname === "internal"
    || hostname === "alt"
    || hostname === "onion"
    || RESERVED_PUBLIC_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
    || PLACEHOLDER_PUBLIC_HOSTS.some(
      (placeholder) => hostname === placeholder || hostname.endsWith(`.${placeholder}`),
    )
    || hostname.endsWith(".local")
  ) {
    return true;
  }
  if (!hostname.includes(".") && !hostname.includes(":")) return true;

  const ipv4 = parseIpv4(hostname);
  if (ipv4) {
    const [first = -1, second = -1, third = -1] = ipv4;
    return (
      first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 0 && third === 0)
      || (first === 192 && second === 168)
      || (first === 192 && second === 0 && third === 2)
      || (first === 192 && second === 88 && third === 99)
      || (first === 198 && (second === 18 || second === 19))
      || (first === 198 && second === 51 && third === 100)
      || (first === 203 && second === 0 && third === 113)
      || first >= 224
    );
  }

  const ipv6 = parseIpv6(hostname);
  if (ipv6) {
    const [first = -1, second = -1, third = -1, fourth = -1] = ipv6;
    if (
      ipv6.every((group) => group === 0)
      || (ipv6.slice(0, 7).every((group) => group === 0) && ipv6[7] === 1)
      || (first & 0xfe00) === 0xfc00
      || (first & 0xffc0) === 0xfe80
      || (first & 0xff00) === 0xff00
      || (first === 0x0100 && second === 0 && third === 0 && fourth === 0)
      || (first === 0x0064 && second === 0xff9b && third === 1)
      || (first === 0x2001 && second <= 0x01ff)
      || (first === 0x2001 && second === 0x0db8)
      || first === 0x2002
      || (first === 0x3fff && (second & 0xf000) === 0)
      || first === 0x5f00
    ) {
      return true;
    }

    const isIpv4Compatible = ipv6.slice(0, 6).every((group) => group === 0);
    const isIpv4Mapped = ipv6.slice(0, 5).every((group) => group === 0)
      && ipv6[5] === 0xffff;
    const isWellKnownNat64 = first === 0x0064
      && second === 0xff9b
      && ipv6.slice(2, 6).every((group) => group === 0);
    if (isIpv4Compatible || isIpv4Mapped) return true;
    if (isWellKnownNat64) {
      return isNonPublicHostname(ipv4FromIpv6Tail(ipv6));
    }
    if ((first & 0xe000) !== 0x2000) return true;
  }

  return false;
}

function decodeJwtRole(candidate: string): string | null {
  const segments = candidate.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(segments[1] ?? "", "base64url").toString("utf8"),
    ) as { role?: unknown };
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

function isSupabasePublicKey(candidate: string): boolean {
  return (
    /^sb_publishable_[A-Za-z0-9_-]{10,}$/u.test(candidate)
    || decodeJwtRole(candidate) === "anon"
  );
}

function isSupabaseServiceKey(candidate: string): boolean {
  return (
    /^sb_secret_[A-Za-z0-9_-]{10,}$/u.test(candidate)
    || decodeJwtRole(candidate) === "service_role"
  );
}

function addPublicHostnameIssue(
  context: z.RefinementCtx,
  key: string,
  value: string | undefined,
): void {
  if (value === undefined) return;
  const url = new URL(value);
  if (isNonPublicHostname(url.hostname)) {
    context.addIssue({
      code: "custom",
      path: [key],
      message: `${key} must not use a private, reserved, documentation, or placeholder hostname`,
    });
  }
}

const serverEnvironmentSchema = z.object({
  VERCEL_ENV: z.enum(["development", "preview", "production"]).optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().trim().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().trim().min(1),
  PUBLIC_RECRUIT_GATE: z.string().optional(),
  PUBLIC_SHARE_CREATION: z.string().optional(),
  PUBLIC_SHARE_PUBLICATION: z.string().optional(),
  BONUS_PACK_ISSUANCE_SCOPE: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.enum(["off", "participants", "public"]).optional().default("off"),
  ),
  BONUS_PACK_CURSOR_SECRET: optionalEnvironmentString(z.string().min(32)),
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
  if (!PUBLIC_DEPLOYMENT_ENVIRONMENTS.has(environment.VERCEL_ENV ?? "")) return;

  const requiredProductionKeys = [
    "ACCOUNT_DELETION_RATE_LIMIT_SECRET",
    "ACCOUNT_DELETION_SUPPORT_URL",
    "PUBLIC_SUPPORT_URL",
    "ACCOUNT_DELETION_DEVELOPER_NAME",
    "PUBLIC_APP_URL",
    "CRON_SECRET",
    "BONUS_PACK_CURSOR_SECRET",
    "COLLECTION_CURSOR_SECRET",
    "LOCATION_COMPLIANCE_CURSOR_SECRET",
    "ABUSE_HMAC_SECRET",
  ] as const;
  for (const key of requiredProductionKeys) {
    if (environment[key] === undefined) {
      context.addIssue({
        code: "custom",
        path: [key],
        message: `${key} is required for preview and production deployments`,
      });
    }
  }

  const supabaseUrl = new URL(environment.NEXT_PUBLIC_SUPABASE_URL);
  if (
    supabaseUrl.protocol !== "https:"
    || supabaseUrl.username !== ""
    || supabaseUrl.password !== ""
    || supabaseUrl.pathname !== "/"
    || supabaseUrl.search !== ""
    || supabaseUrl.hash !== ""
  ) {
    context.addIssue({
      code: "custom",
      path: ["NEXT_PUBLIC_SUPABASE_URL"],
      message: "NEXT_PUBLIC_SUPABASE_URL must be a public HTTPS origin without credentials, path, query, or fragment",
    });
  }
  addPublicHostnameIssue(
    context,
    "NEXT_PUBLIC_SUPABASE_URL",
    environment.NEXT_PUBLIC_SUPABASE_URL,
  );
  addPublicHostnameIssue(context, "PUBLIC_APP_URL", environment.PUBLIC_APP_URL);
  addPublicHostnameIssue(
    context,
    "ACCOUNT_DELETION_SUPPORT_URL",
    environment.ACCOUNT_DELETION_SUPPORT_URL,
  );
  addPublicHostnameIssue(
    context,
    "PUBLIC_SUPPORT_URL",
    environment.PUBLIC_SUPPORT_URL,
  );
  const authEmailRedirect = new URL(environment.AUTH_EMAIL_REDIRECT_TO);
  if (authEmailRedirect.protocol === "https:") {
    addPublicHostnameIssue(
      context,
      "AUTH_EMAIL_REDIRECT_TO",
      environment.AUTH_EMAIL_REDIRECT_TO,
    );
  }
  if (authEmailRedirect.href !== "danyeodam://auth/callback") {
    context.addIssue({
      code: "custom",
      path: ["AUTH_EMAIL_REDIRECT_TO"],
      message: "AUTH_EMAIL_REDIRECT_TO must be exactly danyeodam://auth/callback in preview and production",
    });
  }

  if (!isSupabasePublicKey(environment.NEXT_PUBLIC_SUPABASE_ANON_KEY)) {
    context.addIssue({
      code: "custom",
      path: ["NEXT_PUBLIC_SUPABASE_ANON_KEY"],
      message: "NEXT_PUBLIC_SUPABASE_ANON_KEY must be an sb_publishable key or a legacy anon JWT",
    });
  }
  if (!isSupabaseServiceKey(environment.SUPABASE_SERVICE_ROLE_KEY)) {
    context.addIssue({
      code: "custom",
      path: ["SUPABASE_SERVICE_ROLE_KEY"],
      message: "SUPABASE_SERVICE_ROLE_KEY must be an sb_secret key or a legacy service_role JWT",
    });
  }
  if (
    environment.NEXT_PUBLIC_SUPABASE_ANON_KEY
    === environment.SUPABASE_SERVICE_ROLE_KEY
  ) {
    context.addIssue({
      code: "custom",
      path: ["SUPABASE_SERVICE_ROLE_KEY"],
      message: "Supabase public and service keys must be different",
    });
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
