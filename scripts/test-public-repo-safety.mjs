import assert from 'node:assert/strict';
import test from 'node:test';

import {
  forbiddenPathReason,
  scanText,
} from './lib/public-repo-safety.mjs';

test('forbidden credential and artifact paths are rejected', () => {
  assert.equal(forbiddenPathReason('.env.production'), 'environment file');
  assert.equal(forbiddenPathReason('android/upload.keystore'), 'credential or release-artifact extension');
  assert.equal(forbiddenPathReason('release/app.aab'), 'credential or release-artifact extension');
  assert.equal(forbiddenPathReason('GoogleService-Info.plist'), 'credential-bearing filename');
  assert.equal(forbiddenPathReason('.env.example'), null);
});

test('high-risk credential material and user paths are detected', () => {
  const privateKey = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  const githubToken = `gh${'p'}_${'a'.repeat(36)}`;
  const jwt = `${'eyJ'}${'a'.repeat(12)}.${'b'.repeat(16)}.${'c'.repeat(16)}`;

  assert.deepEqual(scanText(privateKey), ['private key material']);
  assert.deepEqual(scanText(githubToken), ['GitHub token']);
  assert.deepEqual(scanText(jwt), ['JWT credential']);
  assert.deepEqual(scanText(['/Users', 'someone', 'private.txt'].join('/')), ['macOS user path']);
});

test('documented placeholders and public keys are accepted', () => {
  assert.deepEqual(scanText('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=replace-with-local-publishable-key'), []);
  assert.deepEqual(scanText('https://project.supabase.co'), []);
  assert.deepEqual(scanText('support@example.test'), []);
});
