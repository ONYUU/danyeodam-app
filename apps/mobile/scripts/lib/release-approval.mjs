import {
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const RFC_3339_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

function assertClosedKeys(value, expectedKeys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(sortedExpectedKeys)) {
    throw new Error(`${label} must contain exactly: ${sortedExpectedKeys.join(', ')}.`);
  }
}

function isInside(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function readReleaseApproval({ approvalFile, repositoryRoot, sourceCommitSha }) {
  if (!path.isAbsolute(approvalFile ?? '')) {
    throw new Error('DANYEODAM_RELEASE_APPROVAL_FILE must be an absolute path.');
  }
  if (!GIT_SHA_PATTERN.test(sourceCommitSha ?? '')) {
    throw new Error('EAS_BUILD_GIT_COMMIT_HASH must be an exact lowercase Git commit SHA for a production build.');
  }

  const fileStat = lstatSync(approvalFile);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error('The private release approval must be a regular file, not a symlink.');
  }
  if (fileStat.size <= 0 || fileStat.size > 16_384) {
    throw new Error('The private release approval file must be between 1 and 16384 bytes.');
  }
  if (process.platform !== 'win32' && (fileStat.mode & 0o077) !== 0) {
    throw new Error('The private release approval file must not be readable or writable by group or other users.');
  }

  const resolvedRepositoryRoot = realpathSync(repositoryRoot);
  const resolvedApprovalFile = realpathSync(approvalFile);
  if (isInside(resolvedRepositoryRoot, resolvedApprovalFile)) {
    throw new Error('The private release approval file must be supplied from outside the public repository.');
  }

  let approval;
  try {
    approval = JSON.parse(readFileSync(resolvedApprovalFile, 'utf8'));
  } catch {
    throw new Error('The private release approval file must contain valid JSON.');
  }

  assertClosedKeys(
    approval,
    ['approvedAt', 'approvedBy', 'evidence', 'schemaVersion', 'sourceCommitSha', 'status'],
    'Release approval',
  );
  assertClosedKeys(
    approval.evidence,
    ['cardAssetRightsSha256', 'seoulFieldApprovalSha256', 'storePacketPrebuildSha256'],
    'Release approval evidence',
  );

  if (approval.schemaVersion !== 1 || approval.status !== 'approved') {
    throw new Error('The private release approval must use schemaVersion 1 and status approved.');
  }
  if (approval.sourceCommitSha !== sourceCommitSha) {
    throw new Error('The private release approval sourceCommitSha must match the exact EAS build commit.');
  }
  if (
    typeof approval.approvedBy !== 'string'
    || approval.approvedBy.trim() !== approval.approvedBy
    || approval.approvedBy.length < 2
    || approval.approvedBy.length > 100
    || /[\r\n]/u.test(approval.approvedBy)
  ) {
    throw new Error('The private release approval approvedBy value is invalid.');
  }
  if (
    typeof approval.approvedAt !== 'string'
    || !RFC_3339_UTC_PATTERN.test(approval.approvedAt)
    || !Number.isFinite(Date.parse(approval.approvedAt))
    || Date.parse(approval.approvedAt) > Date.now() + 300_000
  ) {
    throw new Error('The private release approval approvedAt value must be a valid UTC timestamp that is not in the future.');
  }
  for (const [key, value] of Object.entries(approval.evidence)) {
    if (typeof value !== 'string' || !SHA_256_PATTERN.test(value)) {
      throw new Error(`The private release approval evidence.${key} value must be a lowercase SHA-256.`);
    }
  }

  return approval;
}
