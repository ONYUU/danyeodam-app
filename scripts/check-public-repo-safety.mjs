import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  forbiddenPathReason,
  publicStaticImageReason,
  scanText,
} from './lib/public-repo-safety.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { cwd: root },
);
const files = output.toString('utf8').split('\0').filter(Boolean);
const findings = [];

for (const relativePath of files) {
  const pathReason = forbiddenPathReason(relativePath);
  if (pathReason !== null) {
    findings.push(`${relativePath}: ${pathReason}`);
  }

  const absolutePath = path.join(root, relativePath);
  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    findings.push(`${relativePath}: symbolic links are not allowed in the public repository`);
    continue;
  }
  if (!stat.isFile()) {
    continue;
  }

  const buffer = readFileSync(absolutePath);
  const imageReason = publicStaticImageReason(relativePath, buffer);
  if (imageReason !== null) {
    findings.push(`${relativePath}: ${imageReason}`);
  }
  if (buffer.includes(0)) {
    continue;
  }
  for (const label of scanText(buffer.toString('utf8'))) {
    findings.push(`${relativePath}: ${label}`);
  }
}

if (findings.length > 0) {
  console.error('Public repository safety check failed:');
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Public repository safety check passed (${files.length} files).`);
}
