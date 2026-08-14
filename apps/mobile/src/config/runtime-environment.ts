import Constants from 'expo-constants';

import {
  resolvePublicEnvironment,
  type PublicEnvironment,
} from './environment';

interface ExpoExtra {
  appEnvironment?: string;
  apiBaseUrl?: string;
  supabaseUrl?: string;
  supabasePublishableKey?: string;
  policyAllowedOrigins?: string[];
  buildSourceCommitSha?: unknown;
}

export interface RuntimeEnvironment extends PublicEnvironment {
  buildSourceCommitSha: string | null;
}

function isEmptyPlainObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.keys(value).length === 0
  );
}

function resolveBuildSourceCommitSha(
  value: unknown,
): string | null {
  if (
    value === null ||
    value === undefined ||
    isEmptyPlainObject(value)
  ) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(
      'EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA must be a lowercase 40-character Git commit SHA.',
    );
  }

  const candidate = value.trim() || null;
  if (candidate !== null && !/^[a-f0-9]{40}$/.test(candidate)) {
    throw new Error(
      'EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA must be a lowercase 40-character Git commit SHA.',
    );
  }
  return candidate;
}

export function getRuntimeEnvironment(): RuntimeEnvironment {
  const extra = (Constants.expoConfig?.extra ?? {}) as ExpoExtra;
  const publicEnvironment = resolvePublicEnvironment({
    APP_ENV: extra.appEnvironment,
    EXPO_PUBLIC_API_BASE_URL: extra.apiBaseUrl,
    EXPO_PUBLIC_SUPABASE_URL: extra.supabaseUrl,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: extra.supabasePublishableKey,
    EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS:
      extra.policyAllowedOrigins?.join(',')
      ?? process.env.EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS,
  });

  return {
    ...publicEnvironment,
    buildSourceCommitSha: resolveBuildSourceCommitSha(
      process.env.EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA ??
        extra.buildSourceCommitSha,
    ),
  };
}
