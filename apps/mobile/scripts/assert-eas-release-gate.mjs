#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readReleaseApproval } from './lib/release-approval.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../..');

if (process.env.EAS_BUILD_PROFILE !== 'production') {
  process.stdout.write('EAS private release approval gate skipped outside the production profile.\n');
  process.exit(0);
}

const sourceCommitSha = process.env.EAS_BUILD_GIT_COMMIT_HASH;
readReleaseApproval({
  approvalFile: process.env.DANYEODAM_RELEASE_APPROVAL_FILE,
  repositoryRoot,
  sourceCommitSha,
});

const setEnvironment = spawnSync(
  'set-env',
  ['EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA', sourceCommitSha],
  { encoding: 'utf8', stdio: 'inherit' },
);
if (setEnvironment.error || setEnvironment.status !== 0) {
  throw new Error(`Could not pin the source commit into later EAS build phases: ${setEnvironment.error?.message ?? `set-env exited ${String(setEnvironment.status)}`}`);
}

process.stdout.write('EAS private release approval gate passed.\n');
