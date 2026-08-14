#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readReleaseApproval } from './lib/release-approval.mjs';
import attestationModule from './lib/mobile-public-config-attestation.cjs';

const { createMobilePublicConfigAttestation } = attestationModule;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../..');

if (process.env.EAS_BUILD_PROFILE !== 'production') {
  process.stdout.write('EAS private release approval gate skipped outside the production profile.\n');
  process.exit(0);
}
if (process.env.EAS_BUILD !== 'true') {
  throw new Error('The production release approval gate must run inside an actual EAS build.');
}
if (process.env.APP_ENV !== 'production') {
  throw new Error('The production EAS profile must build with APP_ENV=production.');
}

const sourceCommitSha = process.env.EAS_BUILD_GIT_COMMIT_HASH;
const approval = readReleaseApproval({
  approvalFile: process.env.DANYEODAM_RELEASE_APPROVAL_FILE,
  repositoryRoot,
  sourceCommitSha,
});
const mobilePackage = JSON.parse(
  readFileSync(path.join(repositoryRoot, 'apps/mobile/package.json'), 'utf8'),
);
const attestation = createMobilePublicConfigAttestation({
  apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL,
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
  supabasePublishableKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  policyAllowedOrigins: process.env.EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS,
  mobileAppVersion: mobilePackage.version,
  sourceCommitSha,
  expectedServerBonusPackIssuanceScope:
    approval.expectedServerBonusPackIssuanceScope,
});
if (attestation.mobilePublicConfigSha256 !== approval.mobilePublicConfigSha256) {
  throw new Error(
    'The private release approval mobilePublicConfigSha256 must match the current production public configuration.',
  );
}

const setEnvironment = spawnSync(
  'set-env',
  ['EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA', sourceCommitSha],
  { encoding: 'utf8', stdio: 'inherit' },
);
if (setEnvironment.error || setEnvironment.status !== 0) {
  throw new Error(`Could not pin the source commit into later EAS build phases: ${setEnvironment.error?.message ?? `set-env exited ${String(setEnvironment.status)}`}`);
}

process.stdout.write('EAS private release approval gate passed.\n');
