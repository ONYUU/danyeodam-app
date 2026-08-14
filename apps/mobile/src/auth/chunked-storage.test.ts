import { describe, expect, it } from 'vitest';

import {
  createChunkedStorage,
  type AsyncKeyValueStorage,
} from './chunked-storage';

type BackendOperation = 'get' | 'set' | 'remove';

type MemoryBackend = AsyncKeyValueStorage & {
  values: Map<string, string>;
  operations: { operation: BackendOperation; key: string }[];
  failNext(operation: BackendOperation, matches: (key: string) => boolean): void;
};

function memoryBackend(): MemoryBackend {
  const values = new Map<string, string>();
  const operations: MemoryBackend['operations'] = [];
  const failures: { operation: BackendOperation; matches: (key: string) => boolean }[] = [];

  function record(operation: BackendOperation, key: string): void {
    operations.push({ operation, key });
    const failureIndex = failures.findIndex((failure) =>
      failure.operation === operation && failure.matches(key));
    if (failureIndex !== -1) {
      failures.splice(failureIndex, 1);
      throw new Error(`INJECTED_${operation.toUpperCase()}_FAILURE`);
    }
  }

  return {
    values,
    operations,
    failNext(operation, matches) {
      failures.push({ operation, matches });
    },
    async getItem(key) {
      record('get', key);
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      record('set', key);
      values.set(key, value);
    },
    async removeItem(key) {
      record('remove', key);
      values.delete(key);
    },
  };
}

function storedKey(backend: MemoryBackend, suffix: string): string {
  const key = [...backend.values.keys()].find((candidate) => candidate.endsWith(suffix));
  if (key === undefined) {
    throw new Error(`Missing test storage key with suffix: ${suffix}`);
  }
  return key;
}

describe('chunked auth storage', () => {
  it('round-trips a session larger than a legacy keychain item', async () => {
    const backend = memoryBackend();
    const storage = createChunkedStorage(backend, () => 'generation01');
    const session = JSON.stringify({ access_token: 'a'.repeat(5_000), user: '한글📍' });

    await storage.setItem('supabase.auth.token', session);

    expect(await storage.getItem('supabase.auth.token')).toBe(session);
    expect(backend.values.size).toBeGreaterThan(2);
  });

  it('publishes the new generation before removing the previous chunks', async () => {
    const backend = memoryBackend();
    const generations = ['generation01', 'generation02'];
    const storage = createChunkedStorage(backend, () => generations.shift() ?? 'generation03');

    await storage.setItem('session', 'old'.repeat(1_000));
    await storage.setItem('session', 'new');

    expect(await storage.getItem('session')).toBe('new');
    expect([...backend.values.keys()].some((key) => key.includes('generation01'))).toBe(false);
  });

  it('returns no session when a committed generation is incomplete', async () => {
    const backend = memoryBackend();
    const storage = createChunkedStorage(backend, () => 'generation01');
    await storage.setItem('session', 'x'.repeat(4_000));
    const chunkKey = [...backend.values.keys()].find((key) => key.endsWith('.1'));
    expect(chunkKey).toBeDefined();
    backend.values.delete(chunkKey as string);

    expect(await storage.getItem('session')).toBeNull();
  });

  it('removes the manifest and all reachable chunks', async () => {
    const backend = memoryBackend();
    const storage = createChunkedStorage(backend, () => 'generation01');
    await storage.setItem('session', 'secret'.repeat(1_000));

    await storage.removeItem('session');

    expect(await storage.getItem('session')).toBeNull();
    expect(backend.values.size).toBe(0);
  });

  it('registers a generation before writing chunks and preserves the old value after a partial write', async () => {
    const backend = memoryBackend();
    const generations = ['generation01', 'generation02'];
    const storage = createChunkedStorage(backend, () => generations.shift() ?? 'generation03');
    const oldValue = 'old-session';
    await storage.setItem('session', oldValue);

    backend.operations.length = 0;
    backend.failNext(
      'set',
      (key) => key.includes('.generation02.') && key.endsWith('.1'),
    );
    await expect(storage.setItem('session', 'new'.repeat(1_000))).rejects.toThrow(
      'INJECTED_SET_FAILURE',
    );

    expect(await storage.getItem('session')).toBe(oldValue);
    const journalWriteIndex = backend.operations.findIndex(({ operation, key }) =>
      operation === 'set' && key.endsWith('.generations'));
    const firstChunkWriteIndex = backend.operations.findIndex(({ operation, key }) =>
      operation === 'set' && key.includes('.generation02.'));
    expect(journalWriteIndex).toBeGreaterThanOrEqual(0);
    expect(firstChunkWriteIndex).toBeGreaterThan(journalWriteIndex);
    expect(backend.values.get(storedKey(backend, '.generations'))).toContain('generation02');

    const recreated = createChunkedStorage(backend, () => 'generation03');
    await recreated.removeItem('session');
    expect(backend.values.size).toBe(0);
  });

  it('keeps a failed old-generation cleanup discoverable after publishing the new manifest', async () => {
    const backend = memoryBackend();
    const generations = ['generation01', 'generation02'];
    const storage = createChunkedStorage(backend, () => generations.shift() ?? 'generation03');
    await storage.setItem('session', 'old-session');

    backend.failNext(
      'remove',
      (key) => key.includes('.generation01.') && key.endsWith('.0'),
    );
    await expect(storage.setItem('session', 'new-session')).rejects.toThrow(
      'Authentication secure-storage cleanup did not complete.',
    );

    expect(await storage.getItem('session')).toBe('new-session');
    expect([...backend.values.keys()]).toEqual(expect.arrayContaining([
      expect.stringContaining('.generation01.'),
    ]));
    expect(backend.values.get(storedKey(backend, '.generations'))).toContain('generation01');
    expect(backend.values.get(storedKey(backend, '.generations'))).toContain('generation02');

    const recreated = createChunkedStorage(backend, () => 'generation03');
    await recreated.setItem('session', 'newest-session');

    expect(await recreated.getItem('session')).toBe('newest-session');
    expect([...backend.values.keys()].some((key) => key.includes('.generation01.'))).toBe(false);
    expect([...backend.values.keys()].some((key) => key.includes('.generation02.'))).toBe(false);
    expect(backend.values.get(storedKey(backend, '.generations'))).not.toContain('generation01');
    expect(backend.values.get(storedKey(backend, '.generations'))).not.toContain('generation02');
  });

  it('surfaces deletion failures, retains the journal, and removes every generation on retry', async () => {
    const backend = memoryBackend();
    const generations = ['generation01', 'generation02'];
    const storage = createChunkedStorage(backend, () => generations.shift() ?? 'generation03');
    await storage.setItem('session', 'current-session');

    backend.failNext(
      'set',
      (key) => key.includes('.generation02.') && key.endsWith('.1'),
    );
    await expect(storage.setItem('session', 'interrupted'.repeat(1_000))).rejects.toThrow(
      'INJECTED_SET_FAILURE',
    );
    expect(backend.values.get(storedKey(backend, '.generations'))).toContain('generation02');

    backend.failNext(
      'remove',
      (key) => key.includes('.generation02.') && key.endsWith('.0'),
    );
    const recreated = createChunkedStorage(backend, () => 'generation03');
    await expect(recreated.removeItem('session')).rejects.toThrow(
      'Authentication secure-storage cleanup did not complete.',
    );

    expect(await recreated.getItem('session')).toBeNull();
    expect(backend.values.get(storedKey(backend, '.generations'))).toContain('generation01');
    expect(backend.values.get(storedKey(backend, '.generations'))).toContain('generation02');

    const restartedAgain = createChunkedStorage(backend, () => 'generation04');
    await restartedAgain.removeItem('session');
    expect(backend.values.size).toBe(0);
  });

  it('rejects an over-capacity journal instead of losing registered generations', async () => {
    const backend = memoryBackend();
    const storage = createChunkedStorage(backend, () => 'generation99');
    await storage.setItem('session', 'current-session');
    const key = storedKey(backend, '.generations');
    backend.values.set(key, JSON.stringify({
      version: 1,
      generations: Array.from({ length: 9 }, (_, index) => ({
        generation: `generation${String(index).padStart(2, '0')}`,
        chunks: 1,
      })),
    }));

    await expect(storage.removeItem('session')).rejects.toThrow(
      'Authentication secure-storage journal is invalid.',
    );
    expect(backend.values.has(key)).toBe(true);
  });
});
