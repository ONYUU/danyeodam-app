#!/usr/bin/env node

const deploymentEnvironment = process.env.VERCEL_ENV;

if (deploymentEnvironment !== 'preview' && deploymentEnvironment !== 'production') {
  process.stdout.write(
    'Server deployment environment gate skipped outside Vercel preview/production.\n',
  );
  process.exit(0);
}

const { getServerEnvironment } = await import('../src/server/env.ts');
getServerEnvironment();

process.stdout.write(
  `Server ${deploymentEnvironment} environment gate passed.\n`,
);
