import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const expoCliPath = require.resolve('expo/bin/cli');
const outputDirectory = mkdtempSync(join(tmpdir(), 'danyeodam-export-'));
const exportSourceCommitSha = 'a'.repeat(40);

function containsBytesRecursively(directory, expectedBytes) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (containsBytesRecursively(entryPath, expectedBytes)) {
        return true;
      }
      continue;
    }
    if (entry.isFile() && readFileSync(entryPath).includes(expectedBytes)) {
      return true;
    }
  }
  return false;
}

try {
  const result = spawnSync(
    process.execPath,
    [
      expoCliPath,
      'export',
      '--platform',
      'all',
      '--output-dir',
      outputDirectory,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        APP_ENV: 'production',
        CI: '1',
        EXPO_NO_TELEMETRY: '1',
        EXPO_PUBLIC_API_BASE_URL: 'https://api.ci.danyeodam.invalid',
        EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA: exportSourceCommitSha,
        EXPO_PUBLIC_SUPABASE_URL: 'https://database.ci.danyeodam.invalid',
        EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_ci_validation_only',
        EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS:
          'https://policies.ci.danyeodam.invalid,https://support.ci.danyeodam.invalid',
      },
      stdio: 'inherit',
    },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  for (const platform of ['ios', 'android', 'web']) {
    const platformDirectory = join(
      outputDirectory,
      '_expo',
      'static',
      'js',
      platform,
    );
    assert(
      existsSync(platformDirectory),
      `Missing ${platform} production bundle.`,
    );
    assert(
      containsBytesRecursively(
        platformDirectory,
        Buffer.from(exportSourceCommitSha, 'utf8'),
      ),
      `The ${platform} production bundle does not embed the build source commit.`,
    );
  }
  console.log(
    'Production iOS, Android, and web bundles were exported with the build source commit.',
  );
} finally {
  rmSync(outputDirectory, { recursive: true, force: true });
}
