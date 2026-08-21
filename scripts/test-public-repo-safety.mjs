import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  approvedPublicImages,
  forbiddenPathReason,
  publicBinaryReason,
  publicStaticImageReason,
  scanText,
} from './lib/public-repo-safety.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeIsoBox(type, payload) {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 'ascii');
  payload.copy(box, 8);
  return box;
}

test('forbidden credential and artifact paths are rejected', () => {
  assert.equal(forbiddenPathReason('.env.production'), 'environment file');
  assert.equal(forbiddenPathReason('android/upload.keystore'), 'credential or release-artifact extension');
  assert.equal(forbiddenPathReason('release/app.aab'), 'credential or release-artifact extension');
  assert.equal(forbiddenPathReason('GoogleService-Info.plist'), 'credential-bearing filename');
  assert.equal(forbiddenPathReason('.npmrc'), 'credential-bearing filename');
  assert.equal(forbiddenPathReason('config/service-account-prod.json'), 'service-account credential filename');
  assert.equal(forbiddenPathReason('backup/production.dump'), 'credential or release-artifact extension');
  assert.equal(forbiddenPathReason('.netrc'), 'credential-bearing filename');
  assert.equal(forbiddenPathReason('.pypirc'), 'credential-bearing filename');
  assert.equal(forbiddenPathReason('.sentryclirc'), 'credential-bearing filename');
  assert.equal(forbiddenPathReason('.direnv/secrets'), 'private rights, field, or store evidence path');
  assert.equal(forbiddenPathReason('evidence/release.zip'), 'credential or release-artifact extension');
  assert.equal(forbiddenPathReason('credentials/vault.kdbx'), 'credential or release-artifact extension');
  assert.equal(forbiddenPathReason('data/local.sqlite'), 'credential or release-artifact extension');
  assert.equal(forbiddenPathReason('assets/card-assets/source.png'), 'private rights, field, or store evidence path');
  assert.equal(forbiddenPathReason('content/seoul-launch/approval.json'), 'private rights, field, or store evidence path');
  assert.equal(forbiddenPathReason('docs/REVIEWER-OPERATIONS.md'), 'private operations or release-evidence file');
  for (const privateReleaseValidator of [
    'scripts/lib/private-release-approval-v2.mjs',
    'scripts/lib/store-release-verification.mjs',
    'scripts/lib/strict-json.mjs',
    'scripts/validate-private-release-approval-v2.mjs',
    'scripts/validate-store-release.mjs',
  ]) {
    assert.equal(
      forbiddenPathReason(privateReleaseValidator),
      'private operations or release-evidence file',
      privateReleaseValidator,
    );
  }
  assert.equal(forbiddenPathReason('.env.example'), null);
});

test('only the frozen public images may contain binary NUL bytes', () => {
  const approvedBuffer = readFileSync(path.join(root, 'apps/mobile/assets/images/favicon.png'));
  assert.equal(
    publicBinaryReason('apps/mobile/assets/images/favicon.png', approvedBuffer),
    null,
  );
  assert.equal(
    publicBinaryReason('docs/opaque-payload', Buffer.from([0x01, 0x00, 0x02])),
    'unapproved binary payload',
  );
  assert.equal(publicBinaryReason('docs/plain.txt', Buffer.from('public text', 'utf8')), null);
});

test('GitHub workflows pin actions and discard checkout credentials', () => {
  for (const workflowPath of [
    '.github/workflows/ci.yml',
    '.github/workflows/mobile-ci.yml',
    '.github/workflows/public-security.yml',
    '.github/workflows/release-preflight.yml',
  ]) {
    const source = readFileSync(path.join(root, workflowPath), 'utf8');
    assert.doesNotMatch(source, /pull_request_target:/u, workflowPath);

    const actionReferences = [...source.matchAll(/^\s*- uses:\s+([^\s#]+)/gmu)]
      .map((match) => match[1]);
    assert.ok(actionReferences.length > 0, `${workflowPath} must use at least one action`);
    for (const reference of actionReferences) {
      assert.match(reference, /@[0-9a-f]{40}$/u, `${workflowPath}: ${reference}`);
    }

    const checkoutCount = actionReferences.filter((reference) => (
      reference.startsWith('actions/checkout@')
    )).length;
    const hardenedCheckoutCount = [...source.matchAll(
      /- uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+persist-credentials: false/gmu,
    )].length;
    assert.equal(hardenedCheckoutCount, checkoutCount, workflowPath);
  }
});

test('CI enforces the pinned npm install policy and the lockfile-bound EAS CLI', () => {
  const ci = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const mobileCi = readFileSync(path.join(root, '.github/workflows/mobile-ci.yml'), 'utf8');
  const releasePreflight = readFileSync(
    path.join(root, '.github/workflows/release-preflight.yml'),
    'utf8',
  );
  const mobilePackage = JSON.parse(
    readFileSync(path.join(root, 'apps/mobile/package.json'), 'utf8'),
  );
  const releaseToolPackage = JSON.parse(
    readFileSync(path.join(root, 'tools/eas-cli/package.json'), 'utf8'),
  );

  assert.equal((ci.match(/corepack enable/gu) ?? []).length, 3);
  assert.equal((ci.match(/corepack npm ci --strict-allow-scripts/gu) ?? []).length, 3);
  assert.equal((ci.match(/corepack npm --version\)" = "11\.16\.0"/gu) ?? []).length, 3);
  assert.doesNotMatch(ci, /^\s*- run: npm ci\s*$/gmu);
  assert.doesNotMatch(ci, /\bnpx\s+supabase\b/u);
  assert.equal((ci.match(/corepack npm run db:start/gu) ?? []).length, 2);
  assert.equal((ci.match(/corepack npm run db:stop/gu) ?? []).length, 2);

  for (const [label, workflow] of [
    ['mobile CI', mobileCi],
    ['release preflight', releasePreflight],
  ]) {
    assert.match(workflow, /tools\/eas-cli\/package-lock\.json/u, label);
    assert.match(
      workflow,
      /corepack npm --prefix tools\/eas-cli ci --strict-allow-scripts/u,
      label,
    );
    assert.match(
      workflow,
      /corepack npm --offline --prefix tools\/eas-cli run --silent eas -- --version/u,
      label,
    );
  }
  assert.match(mobileCi, /corepack npm ci --strict-allow-scripts/u);
  assert.match(releasePreflight, /corepack npm --prefix apps\/mobile ci --strict-allow-scripts/u);

  assert.equal(releaseToolPackage.scripts?.eas, 'eas');
  assert.equal(
    mobilePackage.scripts?.['release:build'],
    'corepack npm run release:preflight && corepack npm --offline --prefix ../../tools/eas-cli run eas -- build --profile production --platform all',
  );
  assert.doesNotMatch(mobilePackage.scripts?.['release:build'] ?? '', /\bnpx\b|npm exec/u);
});

test('high-risk credential material and user paths are detected', () => {
  const privateKey = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  const githubToken = `gh${'p'}_${'a'.repeat(36)}`;
  const jwt = `${'eyJ'}${'a'.repeat(12)}.${'b'.repeat(16)}.${'c'.repeat(16)}`;
  const remoteDatabaseUrl = ['postgresql', '://service:', 'real-password', '@db.example.test:5432/postgres'].join('');

  assert.deepEqual(scanText(privateKey), ['private key material']);
  assert.deepEqual(scanText(githubToken), ['GitHub token']);
  assert.deepEqual(scanText(jwt), ['JWT credential']);
  assert.deepEqual(scanText(`GOCSPX-${'a'.repeat(24)}`), ['Google OAuth client secret']);
  assert.deepEqual(
    scanText(remoteDatabaseUrl),
    ['remote database URL with password'],
  );
  assert.deepEqual(scanText('postgresql://postgres:postgres@127.0.0.1:54322/postgres'), []);
  assert.deepEqual(scanText(['/Users', 'someone', 'private.txt'].join('/')), ['macOS user path']);
});

test('documented placeholders and public keys are accepted', () => {
  assert.deepEqual(scanText('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=replace-with-local-publishable-key'), []);
  assert.deepEqual(scanText('https://project.supabase.co'), []);
  assert.deepEqual(scanText('support@example.test'), []);
});

test('the three approved public PNG assets match their frozen safety metadata', () => {
  assert.deepEqual(Object.keys(approvedPublicImages), [
    'apps/mobile/assets/images/android-icon-foreground.png',
    'apps/mobile/assets/images/favicon.png',
    'apps/mobile/assets/images/icon.png',
  ]);

  for (const relativePath of Object.keys(approvedPublicImages)) {
    const buffer = readFileSync(path.join(root, relativePath));
    assert.equal(publicStaticImageReason(relativePath, buffer), null, relativePath);
  }
});

test('dangerous image signatures are rejected even when their extensions are disguised', () => {
  const signatures = [
    ['ICNS', Buffer.from('icns00000000', 'ascii')],
    [
      'JPEG XL',
      Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]),
    ],
    [
      'HEIF',
      Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00, 0x6d, 0x69, 0x66, 0x31, 0x00, 0x00, 0x00, 0x00]),
    ],
    [
      'JPEG 2000',
      Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a]),
    ],
  ];

  for (const [format, buffer] of signatures) {
    assert.equal(
      publicStaticImageReason('apps/mobile/assets/images/favicon.png', buffer),
      `dangerous ${format} image signature`,
      format,
    );
  }
});

test('noncanonical JXL and JP2 containers are rejected on extensionless paths', () => {
  const variants = [
    [
      'JPEG XL',
      Buffer.concat([
        makeIsoBox('JXL ', Buffer.from('variant!', 'ascii')),
        makeIsoBox('ftyp', Buffer.concat([Buffer.from('jxl ', 'ascii'), Buffer.alloc(4)])),
      ]),
    ],
    [
      'JPEG 2000',
      Buffer.concat([
        makeIsoBox('jP  ', Buffer.from('variant!', 'ascii')),
        makeIsoBox('ftyp', Buffer.concat([Buffer.from('jp2 ', 'ascii'), Buffer.alloc(4)])),
      ]),
    ],
  ];

  for (const [format, buffer] of variants) {
    assert.notEqual(buffer.readUInt32BE(0), 12, `${format} fixture must be noncanonical`);
    assert.equal(
      publicStaticImageReason('docs/opaque-payload', buffer),
      `dangerous ${format} image signature`,
      format,
    );
  }
});

test('raw JPEG XL and JPEG 2000 codestream signatures are rejected', () => {
  assert.equal(
    publicStaticImageReason('docs/opaque-payload', Buffer.from([0xff, 0x0a, 0x00, 0x00])),
    'dangerous JPEG XL image signature',
  );
  assert.equal(
    publicStaticImageReason('docs/opaque-payload', Buffer.from([0xff, 0x4f, 0x00, 0x00])),
    'dangerous JPEG 2000 image signature',
  );
});

test('every upstream HEIF and AVIF major brand is rejected', () => {
  for (const brand of ['mif1', 'msf1', 'heic', 'heix', 'hevc', 'hevx']) {
    const buffer = makeIsoBox(
      'ftyp',
      Buffer.concat([Buffer.from(brand, 'ascii'), Buffer.alloc(4)]),
    );
    assert.equal(
      publicStaticImageReason('docs/opaque-payload', buffer),
      'dangerous HEIF image signature',
      brand,
    );
  }

  for (const brand of ['avif', 'avis']) {
    const buffer = makeIsoBox(
      'ftyp',
      Buffer.concat([Buffer.from(brand, 'ascii'), Buffer.alloc(4)]),
    );
    assert.equal(
      publicStaticImageReason('docs/opaque-payload', buffer),
      'unapproved AVIF image signature',
      brand,
    );
  }
});

test('unapproved image paths and recognized image magic fail closed', () => {
  const approvedBuffer = readFileSync(path.join(root, 'apps/mobile/assets/images/favicon.png'));

  assert.equal(
    publicStaticImageReason('apps/mobile/assets/images/new-icon.png', approvedBuffer),
    'unapproved PNG image signature',
  );
  assert.equal(
    publicStaticImageReason('docs/disguised-binary', approvedBuffer),
    'unapproved PNG image signature',
  );
  assert.equal(
    publicStaticImageReason('docs/empty.jpg', Buffer.alloc(0)),
    'unapproved static image path or extension',
  );
  assert.equal(
    publicStaticImageReason('apps/mobile/assets/images/extensionless', Buffer.from('plain text')),
    'unapproved static image path or extension',
  );
  assert.equal(publicStaticImageReason('docs/plain-binary.bin', Buffer.from([0x00, 0x01])), null);
});

test('approved PNG mutations are rejected by size, dimensions, and digest', () => {
  const relativePath = 'apps/mobile/assets/images/favicon.png';
  const approvedBuffer = readFileSync(path.join(root, relativePath));

  assert.equal(
    publicStaticImageReason(relativePath, Buffer.alloc(33)),
    'approved image is not a PNG',
  );

  const invalidHeader = Buffer.from(approvedBuffer);
  invalidHeader.write('NOPE', 12, 'ascii');
  assert.equal(
    publicStaticImageReason(relativePath, invalidHeader),
    'approved PNG has an invalid IHDR',
  );

  const wrongDigest = Buffer.from(approvedBuffer);
  wrongDigest[wrongDigest.length - 1] ^= 0x01;
  assert.equal(
    publicStaticImageReason(relativePath, wrongDigest),
    'approved PNG SHA-256 does not match the allowlist',
  );

  const wrongDimensions = Buffer.from(approvedBuffer);
  wrongDimensions.writeUInt32BE(257, 16);
  assert.equal(
    publicStaticImageReason(relativePath, wrongDimensions),
    'approved PNG dimensions must be 256x256',
  );

  const oversized = Buffer.concat([
    approvedBuffer,
    Buffer.alloc(approvedPublicImages[relativePath].maxBytes - approvedBuffer.length + 1),
  ]);
  assert.equal(
    publicStaticImageReason(relativePath, oversized),
    `approved PNG exceeds ${approvedPublicImages[relativePath].maxBytes} bytes`,
  );
});
