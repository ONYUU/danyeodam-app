import path from 'node:path';

const privateKeyPattern = new RegExp(
  '-----BEGIN ' + '(?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----',
  'u',
);

export const secretPatterns = [
  ['private key material', privateKeyPattern],
  ['GitHub token', /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})/u],
  ['AWS access key', /AKIA[0-9A-Z]{16}/u],
  ['Google API key', /AIza[0-9A-Za-z_-]{30,}/u],
  ['Slack token', /xox[baprs]-[0-9A-Za-z-]{10,}/u],
  ['Stripe secret key', /sk_(?:live|test)_[0-9A-Za-z]{16,}/u],
  ['OpenAI secret key', /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/u],
  ['Supabase secret key', /sb_secret_[A-Za-z0-9_-]{20,}/u],
  ['Google OAuth client secret', /GOCSPX-[A-Za-z0-9_-]{20,}/u],
  ['npm access token', /npm_[A-Za-z0-9]{20,}/u],
  ['SendGrid API key', /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/u],
  ['JWT credential', /eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/u],
  ['remote database URL with password', /postgres(?:ql)?:\/\/[^:\s/@]+:[^@\s]+@(?!127\.0\.0\.1(?::|\/)|localhost(?::|\/))[^\s/]+/iu],
  ['macOS user path', /\/Users\/[^/\s]+\//u],
  ['Windows user path', /[A-Za-z]:\\Users\\[^\\\s]+\\/u],
];

const forbiddenBasenames = new Set([
  '.npmrc',
  'google-services.json',
  'googleservice-info.plist',
  'credentials.json',
  'secrets.json',
]);

const forbiddenExtensions = new Set([
  '.aab',
  '.apk',
  '.apks',
  '.backup',
  '.cer',
  '.crt',
  '.db',
  '.dump',
  '.ipa',
  '.jks',
  '.key',
  '.keystore',
  '.mobileprovision',
  '.p12',
  '.p8',
  '.pem',
  '.provisionprofile',
  '.sqlite',
  '.sqlite3',
]);

const forbiddenPathPrefixes = [
  'assets/card-assets/',
  'content/card-assets/',
  'content/seoul-launch/',
  'content/store-submission/',
];

const forbiddenExactPaths = new Set([
  'docs/ACCOUNT-DELETION-DEPLOYMENT.md',
  'docs/DEPLOYMENT-CHECKLIST.md',
  'docs/LOCATION-COMPLIANCE-DEPLOYMENT.md',
  'docs/RELEASE-CONTENT-REVIEW.md',
  'docs/REVIEWER-OPERATIONS.md',
  'docs/SEOUL-SPOT-FIELD-TEST.md',
  'docs/STORE-READINESS.md',
  'docs/STORE-SUBMISSION-PACKET.md',
  'scripts/finalize-store-submission-artifacts.mjs',
  'scripts/inspect-store-artifacts.mjs',
  'scripts/lib/safe-zip.py',
  'scripts/lib/seoul-launch-deployment.mjs',
  'scripts/lib/store-artifact-inspector.mjs',
  'scripts/lib/store-submission-validator.mjs',
  'scripts/prepare-seoul-launch-deployment.mjs',
  'scripts/publish-seoul-launch-deployment.mjs',
  'scripts/test-card-asset-rights-validator.mjs',
  'scripts/test-seoul-launch-content-validator.mjs',
  'scripts/test-seoul-launch-deployment-db.mjs',
  'scripts/test-store-submission-validator.mjs',
  'scripts/validate-card-asset-rights.mjs',
  'scripts/validate-seoul-launch-content.mjs',
  'scripts/validate-store-submission-packet.mjs',
]);

export function forbiddenPathReason(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  const basename = path.posix.basename(normalized).toLowerCase();
  const extension = path.posix.extname(basename);

  if (forbiddenPathPrefixes.some((prefix) => normalized.startsWith(prefix))) {
    return 'private rights, field, or store evidence path';
  }
  if (forbiddenExactPaths.has(normalized)) {
    return 'private operations or release-evidence file';
  }
  if (
    (basename === '.env' || basename.startsWith('.env.'))
    && basename !== '.env.example'
  ) {
    return 'environment file';
  }
  if (forbiddenBasenames.has(basename)) {
    return 'credential-bearing filename';
  }
  if (basename.includes('service-account') && extension === '.json') {
    return 'service-account credential filename';
  }
  if (forbiddenExtensions.has(extension)) {
    return 'credential or release-artifact extension';
  }
  if (normalized.includes('/.artifacts/') || normalized.startsWith('.artifacts/')) {
    return 'local release evidence directory';
  }
  return null;
}

export function scanText(text) {
  return secretPatterns
    .filter(([, pattern]) => pattern.test(text))
    .map(([label]) => label);
}
