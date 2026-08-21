import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  ANDROID_MARKER_NAME,
  IOS_MARKER_KEY,
  normalizeSourceCommitSha,
  setAndroidBuildSourceMarker,
  setIosBuildSourceMarker,
} = require('../../plugins/with-build-source-commit.cjs') as {
  ANDROID_MARKER_NAME: string;
  IOS_MARKER_KEY: string;
  normalizeSourceCommitSha: (value: unknown) => string | null;
  setAndroidBuildSourceMarker: (
    application: Record<string, unknown>,
    sourceCommitSha: string | null,
  ) => Record<string, unknown>;
  setIosBuildSourceMarker: (
    infoPlist: Record<string, unknown>,
    sourceCommitSha: string | null,
  ) => Record<string, unknown>;
};

describe('native build source marker plugin', () => {
  it('replaces duplicate native markers with one exact lowercase Git SHA', () => {
    const sourceCommitSha = 'a'.repeat(40);
    const infoPlist = { [IOS_MARKER_KEY]: 'b'.repeat(40) };
    const application = {
      'meta-data': [
        { $: { 'android:name': ANDROID_MARKER_NAME, 'android:value': 'b'.repeat(40) } },
        { $: { 'android:name': 'unrelated', 'android:value': 'kept' } },
        { $: { 'android:name': ANDROID_MARKER_NAME, 'android:value': 'c'.repeat(40) } },
      ],
    };

    setIosBuildSourceMarker(infoPlist, sourceCommitSha);
    setAndroidBuildSourceMarker(application, sourceCommitSha);

    expect(infoPlist).toEqual({ [IOS_MARKER_KEY]: sourceCommitSha });
    expect(application['meta-data']).toEqual([
      { $: { 'android:name': 'unrelated', 'android:value': 'kept' } },
      { $: { 'android:name': ANDROID_MARKER_NAME, 'android:value': sourceCommitSha } },
    ]);
  });

  it('removes stale native markers when no verified SHA exists', () => {
    const infoPlist = { [IOS_MARKER_KEY]: 'b'.repeat(40), retained: true };
    const application = {
      'meta-data': [
        { $: { 'android:name': ANDROID_MARKER_NAME, 'android:value': 'b'.repeat(40) } },
        { $: { 'android:name': 'unrelated', 'android:value': 'kept' } },
      ],
    };

    setIosBuildSourceMarker(infoPlist, null);
    setAndroidBuildSourceMarker(application, null);

    expect(infoPlist).toEqual({ retained: true });
    expect(application['meta-data']).toEqual([
      { $: { 'android:name': 'unrelated', 'android:value': 'kept' } },
    ]);
  });

  it.each(['A'.repeat(40), 'a'.repeat(39), 'not-a-sha', 123])(
    'rejects malformed marker value %s',
    (value) => {
      expect(() => normalizeSourceCommitSha(value)).toThrow(
        'lowercase 40-character sourceCommitSha',
      );
    },
  );
});
