export const APP_ENVIRONMENTS: readonly [
  'development',
  'e2e',
  'preview',
  'production',
];

export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

export interface PublicEnvironment {
  appEnvironment: AppEnvironment;
  apiBaseUrl: string;
  supabaseUrl: string;
  supabasePublishableKey: string;
  policyAllowedOrigins: string[];
}

export function isPrivateNetworkHostname(hostname: string): boolean;
export function parseAppEnvironment(
  value: string | undefined,
): AppEnvironment;
export function parseApiBaseUrl(
  value: string | undefined,
  appEnvironment: AppEnvironment,
): string;
export function parseSupabaseUrl(
  value: string | undefined,
  appEnvironment: AppEnvironment,
): string;
export function parseSupabasePublishableKey(
  value: string | undefined,
  appEnvironment: AppEnvironment,
): string;
export function parsePolicyAllowedOrigins(
  value: string | undefined,
  appEnvironment: AppEnvironment,
): string[];
export function resolvePublicEnvironment(input: {
  APP_ENV?: string | undefined;
  EXPO_PUBLIC_API_BASE_URL?: string | undefined;
  EXPO_PUBLIC_SUPABASE_URL?: string | undefined;
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string | undefined;
  EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS?: string | undefined;
}): PublicEnvironment;
