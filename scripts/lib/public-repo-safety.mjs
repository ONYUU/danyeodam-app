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
  ['npm access token', /npm_[A-Za-z0-9]{20,}/u],
  ['SendGrid API key', /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/u],
  ['JWT credential', /eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/u],
  ['macOS user path', /\/Users\/[^/\s]+\//u],
  ['Windows user path', /[A-Za-z]:\\Users\\[^\\\s]+\\/u],
];

const forbiddenBasenames = new Set([
  'google-services.json',
  'googleservice-info.plist',
  'credentials.json',
  'secrets.json',
]);

const forbiddenExtensions = new Set([
  '.aab',
  '.apk',
  '.apks',
  '.cer',
  '.crt',
  '.ipa',
  '.jks',
  '.key',
  '.keystore',
  '.mobileprovision',
  '.p12',
  '.p8',
  '.pem',
  '.provisionprofile',
]);

export function forbiddenPathReason(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  const basename = path.posix.basename(normalized).toLowerCase();
  const extension = path.posix.extname(basename);

  if (
    (basename === '.env' || basename.startsWith('.env.'))
    && basename !== '.env.example'
  ) {
    return 'environment file';
  }
  if (forbiddenBasenames.has(basename)) {
    return 'credential-bearing filename';
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
