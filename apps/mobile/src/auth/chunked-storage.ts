export type AsyncKeyValueStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

type StorageGeneration = {
  generation: string;
  chunks: number;
};

type StorageManifest = StorageGeneration & {
  version: 1;
};

type StorageJournal = {
  version: 1;
  generations: StorageGeneration[];
};

const MAX_CHUNK_BYTES = 1_800;
const MAX_CHUNKS = 64;
const MAX_REGISTERED_GENERATIONS = 8;
const encoder = new TextEncoder();

function stableKeyId(key: string): string {
  let hash = 0x811c9dc5;
  for (const character of key) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function manifestKey(key: string): string {
  return `danyeodam.auth.${stableKeyId(key)}.manifest`;
}

function journalKey(key: string): string {
  return `danyeodam.auth.${stableKeyId(key)}.generations`;
}

function chunkKey(key: string, generation: string, index: number): string {
  return `danyeodam.auth.${stableKeyId(key)}.${generation}.${index}`;
}

function isStorageGeneration(value: unknown): value is StorageGeneration {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<StorageGeneration>;
  return (
    typeof candidate.generation === 'string'
    && /^[a-z0-9]{8,40}$/u.test(candidate.generation)
    && Number.isInteger(candidate.chunks)
    && (candidate.chunks ?? 0) >= 1
    && (candidate.chunks ?? 0) <= MAX_CHUNKS
  );
}

function parseManifest(raw: string | null): StorageManifest | null {
  if (raw === null) {
    return null;
  }
  try {
    const candidate = JSON.parse(raw) as Partial<StorageManifest>;
    if (candidate.version !== 1 || !isStorageGeneration(candidate)) {
      return null;
    }
    return candidate as StorageManifest;
  } catch {
    return null;
  }
}

function parseJournal(raw: string | null): StorageGeneration[] {
  if (raw === null) {
    return [];
  }

  let candidate: Partial<StorageJournal>;
  try {
    candidate = JSON.parse(raw) as Partial<StorageJournal>;
  } catch {
    throw new Error('Authentication secure-storage journal is invalid.');
  }

  if (
    candidate.version !== 1
    || !Array.isArray(candidate.generations)
    || candidate.generations.length > MAX_REGISTERED_GENERATIONS
    || !candidate.generations.every(isStorageGeneration)
  ) {
    throw new Error('Authentication secure-storage journal is invalid.');
  }

  const generations = candidate.generations as StorageGeneration[];
  if (new Set(generations.map(({ generation }) => generation)).size !== generations.length) {
    throw new Error('Authentication secure-storage journal is invalid.');
  }
  return generations;
}

function serializeJournal(generations: StorageGeneration[]): string {
  const journal: StorageJournal = { version: 1, generations };
  return JSON.stringify(journal);
}

function includeManifest(
  generations: StorageGeneration[],
  manifest: StorageManifest | null,
): StorageGeneration[] {
  if (manifest === null) {
    return generations;
  }

  const existing = generations.find(({ generation }) => generation === manifest.generation);
  if (existing === undefined) {
    if (generations.length >= MAX_REGISTERED_GENERATIONS) {
      throw new Error('Authentication secure-storage journal is full.');
    }
    return [...generations, { generation: manifest.generation, chunks: manifest.chunks }];
  }

  if (existing.chunks === manifest.chunks) {
    return generations;
  }

  return generations.map((entry) => entry.generation === manifest.generation
    ? { ...entry, chunks: Math.max(entry.chunks, manifest.chunks) }
    : entry);
}

function splitUtf8(value: string): string[] {
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;

  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (current && currentBytes + characterBytes > MAX_CHUNK_BYTES) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += character;
    currentBytes += characterBytes;
  }

  chunks.push(current);
  if (chunks.length > MAX_CHUNKS) {
    throw new Error('Authentication session is too large for secure storage.');
  }
  return chunks;
}

async function removeGenerationChunks(
  backend: AsyncKeyValueStorage,
  key: string,
  generation: StorageGeneration,
): Promise<unknown[]> {
  const results = await Promise.allSettled(
    Array.from({ length: generation.chunks }, (_, index) =>
      backend.removeItem(chunkKey(key, generation.generation, index))),
  );
  return results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
}

function cleanupError(errors: unknown[]): Error {
  return new AggregateError(
    errors,
    'Authentication secure-storage cleanup did not complete.',
  );
}

async function cleanupStaleGenerations(
  backend: AsyncKeyValueStorage,
  key: string,
  generations: StorageGeneration[],
  protectedGeneration: string | null,
): Promise<StorageGeneration[]> {
  const retained: StorageGeneration[] = [];
  const errors: unknown[] = [];

  for (const generation of generations) {
    if (generation.generation === protectedGeneration) {
      retained.push(generation);
      continue;
    }

    const generationErrors = await removeGenerationChunks(backend, key, generation);
    if (generationErrors.length > 0) {
      retained.push(generation);
      errors.push(...generationErrors);
    }
  }

  if (retained.length !== generations.length) {
    try {
      await backend.setItem(journalKey(key), serializeJournal(retained));
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw cleanupError(errors);
  }
  return retained;
}

export function createChunkedStorage(
  backend: AsyncKeyValueStorage,
  createGeneration: () => string = () => {
    const time = Date.now().toString(36);
    const random = Math.floor(Math.random() * 0x1_0000_0000)
      .toString(36)
      .padStart(7, '0');
    return `${time}${random}`;
  },
): AsyncKeyValueStorage {
  return {
    async getItem(key) {
      const manifest = parseManifest(await backend.getItem(manifestKey(key)));
      if (manifest === null) {
        return null;
      }

      const chunks: string[] = [];
      for (let index = 0; index < manifest.chunks; index += 1) {
        const chunk = await backend.getItem(chunkKey(key, manifest.generation, index));
        if (chunk === null) {
          return null;
        }
        chunks.push(chunk);
      }
      return chunks.join('');
    },

    async setItem(key, value) {
      const oldManifest = parseManifest(await backend.getItem(manifestKey(key)));
      const registered = includeManifest(
        parseJournal(await backend.getItem(journalKey(key))),
        oldManifest,
      );
      const retained = await cleanupStaleGenerations(
        backend,
        key,
        registered,
        oldManifest?.generation ?? null,
      );

      const generation = createGeneration();
      if (!/^[a-z0-9]{8,40}$/u.test(generation)) {
        throw new Error('Invalid secure-storage generation.');
      }
      if (retained.some((entry) => entry.generation === generation)) {
        throw new Error('Secure-storage generation was reused.');
      }

      const chunks = splitUtf8(value);
      const nextManifest: StorageManifest = {
        version: 1,
        generation,
        chunks: chunks.length,
      };
      if (retained.length >= MAX_REGISTERED_GENERATIONS) {
        throw new Error('Authentication secure-storage journal is full.');
      }

      const withNextGeneration = [
        ...retained,
        { generation, chunks: chunks.length },
      ];
      await backend.setItem(journalKey(key), serializeJournal(withNextGeneration));

      for (const [index, chunk] of chunks.entries()) {
        await backend.setItem(chunkKey(key, generation, index), chunk);
      }
      await backend.setItem(manifestKey(key), JSON.stringify(nextManifest));

      await cleanupStaleGenerations(
        backend,
        key,
        withNextGeneration,
        generation,
      );
    },

    async removeItem(key) {
      const manifest = parseManifest(await backend.getItem(manifestKey(key)));
      const registered = includeManifest(
        parseJournal(await backend.getItem(journalKey(key))),
        manifest,
      );

      if (registered.length > 0) {
        await backend.setItem(journalKey(key), serializeJournal(registered));
      }

      const results = await Promise.allSettled([
        backend.removeItem(manifestKey(key)),
        ...registered.flatMap((generation) =>
          Array.from({ length: generation.chunks }, (_, index) =>
            backend.removeItem(chunkKey(key, generation.generation, index))),
        ),
      ]);
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []);
      if (errors.length > 0) {
        throw cleanupError(errors);
      }

      try {
        await backend.removeItem(journalKey(key));
      } catch (error) {
        throw cleanupError([error]);
      }
    },
  };
}
