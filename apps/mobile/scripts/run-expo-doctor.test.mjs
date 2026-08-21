import { describe, expect, it } from 'vitest';

import { isOnlyExpectedOverrideFailure } from './run-expo-doctor.mjs';

const metroPackages = [
  'metro',
  'metro-babel-transformer',
  'metro-cache',
  'metro-cache-key',
  'metro-config',
  'metro-core',
  'metro-file-map',
  'metro-minify-terser',
  'metro-resolver',
  'metro-runtime',
  'metro-source-map',
  'metro-symbolicate',
  'metro-transform-plugins',
  'metro-transform-worker',
];

function expectedDoctorFailure() {
  return [
    'Running 21 checks on your project...',
    '20/21 checks passed. 1 checks failed. Possible issues detected:',
    '✖ Check for overridden dependencies',
    ...metroPackages.map(
      (packageName) => (
        `"@expo/metro" should install "${packageName}@0.84.4", but 0.84.5 is installed.`
      ),
    ),
    '1 check failed, indicating possible issues with the project.',
  ].join('\n');
}

describe('Expo Doctor bounded Metro exception', () => {
  it('accepts only the complete known override report', () => {
    expect(isOnlyExpectedOverrideFailure(expectedDoctorFailure())).toBe(true);
  });

  it.each([
    ['a second failed check', `${expectedDoctorFailure()}\n✖ Check for unexpected credentials`],
    ['a missing Metro mismatch', expectedDoctorFailure().replace(/.*metro-runtime.*\n/u, '')],
    [
      'a different installed version',
      expectedDoctorFailure().replace(
        'metro@0.84.4", but 0.84.5',
        'metro@0.84.4", but 0.84.6',
      ),
    ],
    ['a different pass count', expectedDoctorFailure().replace('20/21', '19/21')],
  ])('rejects %s', (_name, output) => {
    expect(isOnlyExpectedOverrideFailure(output)).toBe(false);
  });
});
