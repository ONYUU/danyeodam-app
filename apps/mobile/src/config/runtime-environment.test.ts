import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getRuntimeEnvironment } from './runtime-environment';

const constantsState = vi.hoisted(() => ({
  expoConfig: {
    extra: {} as Record<string, unknown>,
  },
}));

vi.mock('expo-constants', () => ({
  default: constantsState,
}));

const originalBuildSourceCommitSha =
  process.env.EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA;

function restoreBuildSourceCommitSha() {
  if (originalBuildSourceCommitSha === undefined) {
    delete process.env.EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA;
  } else {
    process.env.EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA =
      originalBuildSourceCommitSha;
  }
}

beforeEach(() => {
  delete process.env.EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA;
  constantsState.expoConfig.extra = { appEnvironment: 'e2e' };
});

afterEach(restoreBuildSourceCommitSha);

describe('runtime build source commit', () => {
  it.each([
    ['absent', undefined],
    ['null', null],
    ['Expo serialized null placeholder', {}],
    ['null-prototype serialized placeholder', Object.create(null)],
  ])('treats a local %s value as unavailable without crashing', (_label, value) => {
    constantsState.expoConfig.extra.buildSourceCommitSha = value;

    expect(getRuntimeEnvironment()).toMatchObject({
      appEnvironment: 'e2e',
      buildSourceCommitSha: null,
    });
  });

  it('accepts and normalizes a valid lowercase source commit', () => {
    const sourceCommitSha = '0123456789abcdef0123456789abcdef01234567';
    constantsState.expoConfig.extra.buildSourceCommitSha = ` ${sourceCommitSha} `;

    expect(getRuntimeEnvironment().buildSourceCommitSha).toBe(sourceCommitSha);
  });

  it.each([
    '0123456789ABCDEF0123456789ABCDEF01234567',
    'not-a-commit-sha',
    42,
    [],
    { value: '0123456789abcdef0123456789abcdef01234567' },
    new Date(0),
    new Map(),
    new Set(),
    new (class EmptyBuildSourceCommitSha {})(),
  ])('rejects an invalid source commit value %#', (value) => {
    constantsState.expoConfig.extra.buildSourceCommitSha = value;

    expect(getRuntimeEnvironment).toThrow(
      'EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA must be a lowercase 40-character Git commit SHA.',
    );
  });
});
