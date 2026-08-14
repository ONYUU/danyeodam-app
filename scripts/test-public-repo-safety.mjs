import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  approvedPublicImages,
  forbiddenPathReason,
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
  assert.equal(forbiddenPathReason('data/local.sqlite'), 'credential or release-artifact extension');
  assert.equal(forbiddenPathReason('assets/card-assets/source.png'), 'private rights, field, or store evidence path');
  assert.equal(forbiddenPathReason('content/seoul-launch/approval.json'), 'private rights, field, or store evidence path');
  assert.equal(forbiddenPathReason('docs/REVIEWER-OPERATIONS.md'), 'private operations or release-evidence file');
  assert.equal(forbiddenPathReason('.env.example'), null);
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
