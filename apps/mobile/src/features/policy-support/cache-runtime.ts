import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import type { CurrentPolicyManifest } from '@/api/policies';

import {
  encodeCachedPolicyManifest,
  parseCachedPolicyManifest,
  type CachedPolicyManifest,
} from './cache';

const WEB_CACHE_KEY = 'danyeodam.policy-manifest.v1';
const CACHE_FILENAME = 'danyeodam-policy-manifest-v1.json';

function nativeFile(): File {
  return new File(Paths.document, CACHE_FILENAME);
}

async function loadRaw(): Promise<string | null> {
  if (Platform.OS === 'web') {
    return globalThis.localStorage?.getItem(WEB_CACHE_KEY) ?? null;
  }
  const file = nativeFile();
  return file.exists ? file.text() : null;
}

async function saveRaw(value: string): Promise<void> {
  if (Platform.OS === 'web') {
    globalThis.localStorage?.setItem(WEB_CACHE_KEY, value);
    return;
  }
  const destination = nativeFile();
  const temporary = new File(Paths.document, `${CACHE_FILENAME}.tmp`);
  if (temporary.exists) temporary.delete();
  temporary.create({ overwrite: true });
  temporary.write(value);
  await temporary.move(destination, { overwrite: true });
}

export const policyManifestCache = {
  async load(): Promise<CachedPolicyManifest | null> {
    const raw = await loadRaw();
    if (raw === null) return null;
    try {
      return parseCachedPolicyManifest(raw);
    } catch {
      return null;
    }
  },
  async save(manifest: CurrentPolicyManifest): Promise<void> {
    await saveRaw(encodeCachedPolicyManifest(manifest));
  },
};
