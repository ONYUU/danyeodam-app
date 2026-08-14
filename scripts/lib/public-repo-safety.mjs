import { createHash } from 'node:crypto';
import path from 'node:path';

const pngSignature = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export const approvedPublicImages = Object.freeze({
  'apps/mobile/assets/images/android-icon-foreground.png': Object.freeze({
    height: 1024,
    maxBytes: 282 * 1024,
    sha256: 'bf968a9497a24b98710941746508d5292db008b8f77782f877f5d1b48b96c0c6',
    width: 1024,
  }),
  'apps/mobile/assets/images/favicon.png': Object.freeze({
    height: 256,
    maxBytes: 66 * 1024,
    sha256: '3a14433e6a4d2570a96f1e8450175bd126f1b7780b5186f8393a6fc2d9dd68f5',
    width: 256,
  }),
  'apps/mobile/assets/images/icon.png': Object.freeze({
    height: 1024,
    maxBytes: 807 * 1024,
    sha256: 'dab66dfa66408b442d491fa849239cfd63d48c44405126873c070ddb46df100d',
    width: 1024,
  }),
});

const imageExtensions = new Set([
  '.apng',
  '.avif',
  '.bmp',
  '.cur',
  '.dds',
  '.dib',
  '.exr',
  '.gif',
  '.heic',
  '.heif',
  '.icns',
  '.ico',
  '.jfif',
  '.j2c',
  '.j2k',
  '.jp2',
  '.jpe',
  '.jpeg',
  '.jpf',
  '.jpg',
  '.jpm',
  '.jpx',
  '.jxl',
  '.ktx',
  '.ktx2',
  '.mj2',
  '.pam',
  '.pbm',
  '.pgm',
  '.png',
  '.pnm',
  '.pfm',
  '.ppm',
  '.psd',
  '.qoi',
  '.svg',
  '.tga',
  '.tif',
  '.tiff',
  '.webp',
]);

const heifBrands = new Set([
  'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1',
]);
const avifBrands = new Set(['avif', 'avis']);

function startsWithBytes(buffer, bytes) {
  return buffer.length >= bytes.length && buffer.subarray(0, bytes.length).equals(bytes);
}

function isoBaseMediaBrands(buffer) {
  if (buffer.length < 12 || buffer.toString('ascii', 4, 8) !== 'ftyp') {
    return [];
  }

  const declaredSize = buffer.readUInt32BE(0);
  const brands = [buffer.toString('ascii', 8, 12)];
  const boxEnd = declaredSize >= 16
    ? Math.min(buffer.length, declaredSize)
    : buffer.length;
  for (let offset = 16; offset + 4 <= boxEnd; offset += 4) {
    brands.push(buffer.toString('ascii', offset, offset + 4));
  }
  return brands;
}

function dangerousImageFormat(buffer) {
  const initialBoxType = buffer.length >= 8
    ? buffer.toString('ascii', 4, 8)
    : null;
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'icns') {
    return 'ICNS';
  }
  if (
    startsWithBytes(buffer, Buffer.from([0xff, 0x0a]))
    || initialBoxType === 'JXL '
    || startsWithBytes(
      buffer,
      Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]),
    )
  ) {
    return 'JPEG XL';
  }
  if (
    startsWithBytes(
      buffer,
      Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a]),
    )
    || initialBoxType === 'jP  '
    || startsWithBytes(buffer, Buffer.from([0xff, 0x4f]))
    || isoBaseMediaBrands(buffer).some((brand) => ['jp2 ', 'jpx ', 'jpm ', 'mj2 '].includes(brand))
  ) {
    return 'JPEG 2000';
  }
  if (isoBaseMediaBrands(buffer).some((brand) => heifBrands.has(brand))) {
    return 'HEIF';
  }
  return null;
}

function recognizedImageFormat(buffer) {
  const dangerousFormat = dangerousImageFormat(buffer);
  if (dangerousFormat !== null) {
    return dangerousFormat;
  }
  if (startsWithBytes(buffer, pngSignature)) {
    return 'PNG';
  }
  if (startsWithBytes(buffer, Buffer.from([0xff, 0xd8, 0xff]))) {
    return 'JPEG';
  }
  if (
    startsWithBytes(buffer, Buffer.from('GIF87a', 'ascii'))
    || startsWithBytes(buffer, Buffer.from('GIF89a', 'ascii'))
  ) {
    return 'GIF';
  }
  if (
    buffer.length >= 12
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'WebP';
  }
  if (startsWithBytes(buffer, Buffer.from('BM', 'ascii'))) {
    return 'BMP';
  }
  if (
    startsWithBytes(buffer, Buffer.from([0x49, 0x49, 0x2a, 0x00]))
    || startsWithBytes(buffer, Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))
  ) {
    return 'TIFF';
  }
  if (
    startsWithBytes(buffer, Buffer.from([0x00, 0x00, 0x01, 0x00]))
    || startsWithBytes(buffer, Buffer.from([0x00, 0x00, 0x02, 0x00]))
  ) {
    return 'ICO/CUR';
  }
  if (startsWithBytes(buffer, Buffer.from('8BPS', 'ascii'))) {
    return 'Photoshop';
  }
  if (startsWithBytes(buffer, Buffer.from('DDS ', 'ascii'))) {
    return 'DDS';
  }
  if (startsWithBytes(buffer, Buffer.from('qoif', 'ascii'))) {
    return 'QOI';
  }
  if (startsWithBytes(buffer, Buffer.from([0x76, 0x2f, 0x31, 0x01]))) {
    return 'OpenEXR';
  }
  if (
    startsWithBytes(
      buffer,
      Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x31, 0x31, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
    || startsWithBytes(
      buffer,
      Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return 'KTX';
  }
  const brands = isoBaseMediaBrands(buffer);
  if (brands.some((brand) => avifBrands.has(brand))) {
    return 'AVIF';
  }

  const leadingText = buffer.subarray(0, Math.min(buffer.length, 1024)).toString('utf8')
    .replace(/^\uFEFF/u, '')
    .trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/iu.test(leadingText)) {
    return 'SVG';
  }
  if (/^P(?:[1-7]|F)[\t\n\r ]/u.test(leadingText)) {
    return 'PNM';
  }
  if (
    buffer.length >= 18
    && buffer.readUInt16LE(0) === 0
    && buffer.readUInt16LE(4) === 0
  ) {
    return 'TGA';
  }
  return null;
}

function isImageAssetPath(normalizedPath) {
  return normalizedPath.split('/').some((segment, index, segments) => (
    segment.toLowerCase() === 'images'
    && index > 0
    && segments[index - 1].toLowerCase() === 'assets'
  ));
}

export function publicStaticImageReason(filePath, buffer) {
  const normalized = filePath.replaceAll('\\', '/');
  const dangerousFormat = dangerousImageFormat(buffer);
  if (dangerousFormat !== null) {
    return `dangerous ${dangerousFormat} image signature`;
  }

  const approval = Object.hasOwn(approvedPublicImages, normalized)
    ? approvedPublicImages[normalized]
    : undefined;
  if (approval !== undefined) {
    if (!startsWithBytes(buffer, pngSignature)) {
      return 'approved image is not a PNG';
    }
    if (
      buffer.length < 33
      || buffer.readUInt32BE(8) !== 13
      || buffer.toString('ascii', 12, 16) !== 'IHDR'
    ) {
      return 'approved PNG has an invalid IHDR';
    }
    if (buffer.length > approval.maxBytes) {
      return `approved PNG exceeds ${approval.maxBytes} bytes`;
    }

    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width !== approval.width || height !== approval.height) {
      return `approved PNG dimensions must be ${approval.width}x${approval.height}`;
    }

    const digest = createHash('sha256').update(buffer).digest('hex');
    if (digest !== approval.sha256) {
      return 'approved PNG SHA-256 does not match the allowlist';
    }
    return null;
  }

  const recognizedFormat = recognizedImageFormat(buffer);
  if (recognizedFormat !== null) {
    return `unapproved ${recognizedFormat} image signature`;
  }

  const extension = path.posix.extname(path.posix.basename(normalized)).toLowerCase();
  if (imageExtensions.has(extension) || isImageAssetPath(normalized)) {
    return 'unapproved static image path or extension';
  }
  return null;
}

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
