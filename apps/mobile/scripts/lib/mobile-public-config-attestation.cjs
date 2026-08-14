'use strict';

const { createHash } = require('node:crypto');

const {
  resolvePublicEnvironment,
} = require('../../src/config/public-environment.cjs');

const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const MOBILE_APP_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const SERVER_BONUS_PACK_ISSUANCE_SCOPES = [
  'off',
  'participants',
  'public',
];

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function createMobilePublicConfigAttestation({
  apiBaseUrl,
  supabaseUrl,
  supabasePublishableKey,
  policyAllowedOrigins,
  mobileAppVersion,
  sourceCommitSha,
  expectedServerBonusPackIssuanceScope,
}) {
  if (!GIT_SHA_PATTERN.test(sourceCommitSha ?? '')) {
    throw new Error('sourceCommitSha must be an exact lowercase Git commit SHA.');
  }
  if (!MOBILE_APP_VERSION_PATTERN.test(mobileAppVersion ?? '')) {
    throw new Error('mobileAppVersion must be the exact application version.');
  }
  if (!SERVER_BONUS_PACK_ISSUANCE_SCOPES.includes(
    expectedServerBonusPackIssuanceScope,
  )) {
    throw new Error(
      'expectedServerBonusPackIssuanceScope must be off, participants, or public.',
    );
  }

  const publicEnvironment = resolvePublicEnvironment({
    APP_ENV: 'production',
    EXPO_PUBLIC_API_BASE_URL: apiBaseUrl,
    EXPO_PUBLIC_SUPABASE_URL: supabaseUrl,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: supabasePublishableKey,
    EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS: policyAllowedOrigins,
  });
  const canonicalConfig = {
    schemaVersion: 1,
    productionApiBaseUrl: publicEnvironment.apiBaseUrl,
    productionSupabaseUrl: publicEnvironment.supabaseUrl,
    supabasePublishableKeyFingerprintSha256: sha256(
      publicEnvironment.supabasePublishableKey,
    ),
    policyAllowedOrigins: [...publicEnvironment.policyAllowedOrigins].sort(),
    mobileAppVersion,
    sourceCommitSha,
    expectedServerBonusPackIssuanceScope,
  };
  const canonicalJson = JSON.stringify(canonicalConfig);

  return {
    canonicalConfig,
    canonicalJson,
    mobilePublicConfigSha256: sha256(canonicalJson),
  };
}

module.exports = {
  SERVER_BONUS_PACK_ISSUANCE_SCOPES,
  createMobilePublicConfigAttestation,
};
