export const SERVER_BONUS_PACK_ISSUANCE_SCOPES: readonly [
  'off',
  'participants',
  'public',
];

export type ServerBonusPackIssuanceScope =
  (typeof SERVER_BONUS_PACK_ISSUANCE_SCOPES)[number];

export interface MobilePublicConfigAttestationInput {
  apiBaseUrl: string | undefined;
  supabaseUrl: string | undefined;
  supabasePublishableKey: string | undefined;
  policyAllowedOrigins: string | undefined;
  mobileAppVersion: string;
  sourceCommitSha: string;
  expectedServerBonusPackIssuanceScope: ServerBonusPackIssuanceScope;
}

export interface CanonicalMobilePublicConfig {
  schemaVersion: 1;
  productionApiBaseUrl: string;
  productionSupabaseUrl: string;
  supabasePublishableKeyFingerprintSha256: string;
  policyAllowedOrigins: string[];
  mobileAppVersion: string;
  sourceCommitSha: string;
  expectedServerBonusPackIssuanceScope: ServerBonusPackIssuanceScope;
}

export function createMobilePublicConfigAttestation(
  input: MobilePublicConfigAttestationInput,
): {
  canonicalConfig: CanonicalMobilePublicConfig;
  canonicalJson: string;
  mobilePublicConfigSha256: string;
};
