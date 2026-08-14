import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isPublicShareCreationOpen,
  isPublicSharePublicationOpen,
} from "@/server/env";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("public share creation flag", () => {
  it("is closed by default and opens only for an explicit true value", () => {
    expect(isPublicShareCreationOpen(undefined)).toBe(false);
    expect(isPublicShareCreationOpen("false")).toBe(false);
    expect(isPublicShareCreationOpen("1")).toBe(false);
    expect(isPublicShareCreationOpen(" TRUE ")).toBe(true);
  });
});

describe("public share publication flag", () => {
  it("is closed by default and opens only for an explicit true value", () => {
    expect(isPublicSharePublicationOpen(undefined)).toBe(false);
    expect(isPublicSharePublicationOpen("false")).toBe(false);
    expect(isPublicSharePublicationOpen("1")).toBe(false);
    expect(isPublicSharePublicationOpen(" TRUE ")).toBe(true);
  });
});

describe("account deletion deployment environment", () => {
  const stubRequiredBase = () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubEnv("AUTH_EMAIL_REDIRECT_TO", "danyeodam://auth/callback");
    vi.stubEnv("ACCOUNT_DELETION_RATE_LIMIT_SECRET", "r".repeat(32));
    vi.stubEnv("ACCOUNT_DELETION_SUPPORT_URL", "https://support.example/account-delete");
    vi.stubEnv("PUBLIC_SUPPORT_URL", "https://support.example/help");
    vi.stubEnv("ACCOUNT_DELETION_DEVELOPER_NAME", "DANYEODAM");
    vi.stubEnv("CRON_SECRET", "c".repeat(32));
  };

  it("fails production startup when the canonical public deletion origin is missing", async () => {
    stubRequiredBase();
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("PUBLIC_APP_URL", "");
    const { getServerEnvironment } = await import("@/server/env");
    expect(() => getServerEnvironment()).toThrow();
  });

  it("accepts a complete production deletion configuration with an HTTPS origin", async () => {
    stubRequiredBase();
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("PUBLIC_APP_URL", "https://app.example");
    const { getServerEnvironment } = await import("@/server/env");
    expect(getServerEnvironment().PUBLIC_APP_URL).toBe("https://app.example");
  });

  it("fails production startup when the public support URL is missing or insecure", async () => {
    stubRequiredBase();
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("PUBLIC_APP_URL", "https://app.example");
    vi.stubEnv("PUBLIC_SUPPORT_URL", "");
    let environmentModule = await import("@/server/env");
    expect(() => environmentModule.getServerEnvironment()).toThrow();

    vi.resetModules();
    vi.stubEnv("PUBLIC_SUPPORT_URL", "http://support.example/help");
    environmentModule = await import("@/server/env");
    expect(() => environmentModule.getServerEnvironment()).toThrow();
  });
});
