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

describe("bonus pack issuance scope", () => {
  const stubBase = () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubEnv("AUTH_EMAIL_REDIRECT_TO", "danyeodam://auth/callback");
  };

  it("defaults a blank deployment value to off", async () => {
    stubBase();
    vi.stubEnv("BONUS_PACK_ISSUANCE_SCOPE", "");
    vi.resetModules();
    const environmentModule = await import("@/server/env");
    expect(environmentModule.getServerEnvironment().BONUS_PACK_ISSUANCE_SCOPE).toBe("off");
  });

  it.each(["off", "participants", "public"] as const)(
    "accepts the exact server-only scope %s",
    async (scope) => {
      stubBase();
      vi.stubEnv("BONUS_PACK_ISSUANCE_SCOPE", scope);
      vi.resetModules();
      const environmentModule = await import("@/server/env");
      expect(environmentModule.getServerEnvironment().BONUS_PACK_ISSUANCE_SCOPE).toBe(scope);
    },
  );

  it("rejects an unknown scope instead of opening issuance", async () => {
    stubBase();
    vi.stubEnv("BONUS_PACK_ISSUANCE_SCOPE", "true");
    vi.resetModules();
    const environmentModule = await import("@/server/env");
    expect(() => environmentModule.getServerEnvironment()).toThrow();
  });
});

describe("account deletion deployment environment", () => {
  const productionPublicKey = `sb_publishable_${"p".repeat(32)}`;
  const productionServiceKey = `sb_secret_${"s".repeat(32)}`;

  const stubRequiredBase = () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", productionPublicKey);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", productionServiceKey);
    vi.stubEnv("AUTH_EMAIL_REDIRECT_TO", "danyeodam://auth/callback");
    vi.stubEnv("ACCOUNT_DELETION_RATE_LIMIT_SECRET", "r".repeat(32));
    vi.stubEnv(
      "ACCOUNT_DELETION_SUPPORT_URL",
      "https://support.release-fixture.danyeodam.app/account-delete",
    );
    vi.stubEnv(
      "PUBLIC_SUPPORT_URL",
      "https://support.release-fixture.danyeodam.app/help",
    );
    vi.stubEnv("ACCOUNT_DELETION_DEVELOPER_NAME", "DANYEODAM");
    vi.stubEnv("CRON_SECRET", "c".repeat(32));
    vi.stubEnv("BONUS_PACK_CURSOR_SECRET", "b".repeat(32));
    vi.stubEnv("COLLECTION_CURSOR_SECRET", "l".repeat(32));
    vi.stubEnv("LOCATION_COMPLIANCE_CURSOR_SECRET", "o".repeat(32));
    vi.stubEnv("ABUSE_HMAC_SECRET", "a".repeat(32));
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
    vi.stubEnv("PUBLIC_APP_URL", "https://app.release-fixture.danyeodam.app");
    const { getServerEnvironment } = await import("@/server/env");
    expect(getServerEnvironment().PUBLIC_APP_URL).toBe(
      "https://app.release-fixture.danyeodam.app",
    );
  });

  it("fails production startup when the public support URL is missing or insecure", async () => {
    stubRequiredBase();
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("PUBLIC_APP_URL", "https://app.release-fixture.danyeodam.app");
    vi.stubEnv("PUBLIC_SUPPORT_URL", "");
    let environmentModule = await import("@/server/env");
    expect(() => environmentModule.getServerEnvironment()).toThrow();

    vi.resetModules();
    vi.stubEnv("PUBLIC_SUPPORT_URL", "http://support.release-fixture.danyeodam.app/help");
    environmentModule = await import("@/server/env");
    expect(() => environmentModule.getServerEnvironment()).toThrow();
  });

  it.each(["preview", "production"] as const)(
    "requires all cursor and abuse secrets in %s",
    async (deploymentEnvironment) => {
      for (const key of [
        "COLLECTION_CURSOR_SECRET",
        "LOCATION_COMPLIANCE_CURSOR_SECRET",
        "ABUSE_HMAC_SECRET",
      ] as const) {
        stubRequiredBase();
        vi.stubEnv("VERCEL_ENV", deploymentEnvironment);
        vi.stubEnv("PUBLIC_APP_URL", "https://app.release-fixture.danyeodam.app");
        vi.stubEnv(key, "");
        vi.resetModules();
        const environmentModule = await import("@/server/env");
        expect(() => environmentModule.getServerEnvironment()).toThrow(
          `${key} is required for preview and production deployments`,
        );
      }
    },
  );

  it("accepts current and legacy Supabase key roles", async () => {
    const jwt = (role: "anon" | "service_role") => {
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }))
        .toString("base64url");
      const payload = Buffer.from(JSON.stringify({ role })).toString("base64url");
      return `${header}.${payload}.synthetic-signature`;
    };

    for (const [publicKey, serviceKey] of [
      [productionPublicKey, productionServiceKey],
      [jwt("anon"), jwt("service_role")],
    ]) {
      stubRequiredBase();
      vi.stubEnv("VERCEL_ENV", "production");
      vi.stubEnv("PUBLIC_APP_URL", "https://app.release-fixture.danyeodam.app");
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", publicKey);
      vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", serviceKey);
      vi.resetModules();
      const environmentModule = await import("@/server/env");
      expect(environmentModule.getServerEnvironment()).toMatchObject({
        NEXT_PUBLIC_SUPABASE_ANON_KEY: publicKey,
        SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      });
    }
  });

  it("rejects reversed, unknown, and identical Supabase key roles", async () => {
    const jwt = (role: "anon" | "service_role") => {
      const payload = Buffer.from(JSON.stringify({ role })).toString("base64url");
      return `header.${payload}.signature`;
    };
    const mutations = [
      {
        publicKey: jwt("service_role"),
        serviceKey: productionServiceKey,
        message: "must be an sb_publishable key or a legacy anon JWT",
      },
      {
        publicKey: productionPublicKey,
        serviceKey: jwt("anon"),
        message: "must be an sb_secret key or a legacy service_role JWT",
      },
      {
        publicKey: "same-key",
        serviceKey: "same-key",
        message: "Supabase public and service keys must be different",
      },
    ];

    for (const mutation of mutations) {
      stubRequiredBase();
      vi.stubEnv("VERCEL_ENV", "production");
      vi.stubEnv("PUBLIC_APP_URL", "https://app.release-fixture.danyeodam.app");
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", mutation.publicKey);
      vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", mutation.serviceKey);
      vi.resetModules();
      const environmentModule = await import("@/server/env");
      expect(() => environmentModule.getServerEnvironment()).toThrow(mutation.message);
    }
  });

  it.each([
    ["NEXT_PUBLIC_SUPABASE_URL", "https://project.example"],
    ["NEXT_PUBLIC_SUPABASE_URL", "https://database"],
    ["NEXT_PUBLIC_SUPABASE_URL", "https://192.0.2.10"],
    ["NEXT_PUBLIC_SUPABASE_URL", "https://192.0.0.1"],
    ["NEXT_PUBLIC_SUPABASE_URL", "https://192.88.99.1"],
    ["NEXT_PUBLIC_SUPABASE_URL", "https://[2001:db8::10]"],
    ["NEXT_PUBLIC_SUPABASE_URL", "https://[100::1]"],
    ["NEXT_PUBLIC_SUPABASE_URL", "https://[100:0:0:1::1]"],
    ["NEXT_PUBLIC_SUPABASE_URL", "https://[2001:5::1]"],
    ["NEXT_PUBLIC_SUPABASE_URL", "https://[300::1]"],
    ["NEXT_PUBLIC_SUPABASE_URL", "https://[3fff::10]"],
    ["NEXT_PUBLIC_SUPABASE_URL", "https://[::192.0.2.10]"],
    ["NEXT_PUBLIC_SUPABASE_URL", "https://[::8.8.8.8]"],
    ["NEXT_PUBLIC_SUPABASE_URL", "https://[::ffff:8.8.8.8]"],
    ["NEXT_PUBLIC_SUPABASE_URL", "https://[64:ff9b::c000:201]"],
    ["NEXT_PUBLIC_SUPABASE_URL", "https://[ff02::1]"],
    ["PUBLIC_APP_URL", "https://app.invalid"],
    ["PUBLIC_APP_URL", "https://local"],
    ["PUBLIC_APP_URL", "https://example.com"],
    ["PUBLIC_APP_URL", "https://device.home.arpa"],
    ["PUBLIC_APP_URL", "https://service.internal"],
    ["PUBLIC_APP_URL", "https://service.onion"],
    ["ACCOUNT_DELETION_SUPPORT_URL", "https://support.test/account-delete"],
    ["PUBLIC_SUPPORT_URL", "https://support.example.org/help"],
    ["AUTH_EMAIL_REDIRECT_TO", "https://auth.invalid/callback"],
    ["AUTH_EMAIL_REDIRECT_TO", "https://[2001:db8::30]/callback"],
  ] as const)(
    "rejects reserved or placeholder public deployment URL %s=%s",
    async (key, value) => {
      stubRequiredBase();
      vi.stubEnv("VERCEL_ENV", "production");
      vi.stubEnv("PUBLIC_APP_URL", "https://app.release-fixture.danyeodam.app");
      vi.stubEnv(key, value);
      vi.resetModules();
      const environmentModule = await import("@/server/env");
      expect(() => environmentModule.getServerEnvironment()).toThrow(
        "must not use a private, reserved, documentation, or placeholder hostname",
      );
    },
  );

  it.each([
    ["preview", "http://localhost:3000/auth/callback"],
    ["preview", "http://127.0.0.1:3000/auth/callback"],
    ["production", "http://localhost:3000/auth/callback"],
    ["production", "http://127.0.0.1:3000/auth/callback"],
  ] as const)(
    "rejects local HTTP auth redirect in %s: %s",
    async (deploymentEnvironment, redirectUrl) => {
      stubRequiredBase();
      vi.stubEnv("VERCEL_ENV", deploymentEnvironment);
      vi.stubEnv("PUBLIC_APP_URL", "https://app.release-fixture.danyeodam.app");
      vi.stubEnv("AUTH_EMAIL_REDIRECT_TO", redirectUrl);
      vi.resetModules();
      const environmentModule = await import("@/server/env");
      expect(() => environmentModule.getServerEnvironment()).toThrow(
        "must be exactly danyeodam://auth/callback in preview and production",
      );
    },
  );

  it.each([
    "danyeodam://wrong/callback",
    "danyeodam://auth/wrong",
    "danyeodam://auth/callback?redirect=unexpected",
  ])("rejects a non-canonical custom auth callback: %s", async (redirectUrl) => {
    stubRequiredBase();
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("PUBLIC_APP_URL", "https://app.release-fixture.danyeodam.app");
    vi.stubEnv("AUTH_EMAIL_REDIRECT_TO", redirectUrl);
    vi.resetModules();
    const environmentModule = await import("@/server/env");
    expect(() => environmentModule.getServerEnvironment()).toThrow(
      "must be exactly danyeodam://auth/callback in preview and production",
    );
  });

  it.each([
      "https://auth.release-fixture.danyeodam.app/auth/callback",
      "https://app.release-fixture.danyeodam.app/auth/callback",
      "https://app.release-fixture.danyeodam.app/wrong",
      "https://app.release-fixture.danyeodam.app/auth/callback?unexpected=1",
  ])("rejects unsupported HTTPS auth callback: %s", async (redirectUrl) => {
    stubRequiredBase();
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("PUBLIC_APP_URL", "https://app.release-fixture.danyeodam.app");
    vi.stubEnv("AUTH_EMAIL_REDIRECT_TO", redirectUrl);
    vi.resetModules();
    const environmentModule = await import("@/server/env");
    expect(() => environmentModule.getServerEnvironment()).toThrow(
      "must be exactly danyeodam://auth/callback in preview and production",
    );
  });
});
