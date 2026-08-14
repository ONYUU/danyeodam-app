#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import attestationModule from './lib/mobile-public-config-attestation.cjs';

const { createMobilePublicConfigAttestation } = attestationModule;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(scriptDirectory, '..');
const mobilePackage = JSON.parse(
  readFileSync(path.join(mobileRoot, 'package.json'), 'utf8'),
);
const [sourceCommitSha, expectedServerBonusPackIssuanceScope] = process.argv.slice(2);

const attestation = createMobilePublicConfigAttestation({
  apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL,
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
  supabasePublishableKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  policyAllowedOrigins: process.env.EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS,
  mobileAppVersion: mobilePackage.version,
  sourceCommitSha,
  expectedServerBonusPackIssuanceScope,
});

process.stdout.write(`${attestation.mobilePublicConfigSha256}\n`);
