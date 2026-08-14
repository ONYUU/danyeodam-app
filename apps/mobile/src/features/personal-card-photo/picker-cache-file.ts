export type DeletablePickerCacheFile = {
  delete(): void;
  exists: boolean;
};

function strictFilePath(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    if (
      parsed.protocol !== 'file:'
      || parsed.hostname !== ''
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.search !== ''
      || parsed.hash !== ''
    ) {
      return null;
    }
    const path = decodeURIComponent(parsed.pathname);
    if (
      path.includes('\0')
      || path.includes('\\')
      || path.split('/').some((segment) => segment === '.' || segment === '..')
    ) {
      return null;
    }
    return path;
  } catch {
    return null;
  }
}

export function isOwnedImagePickerCacheFile(input: {
  cacheUri: string;
  uri: string;
}): boolean {
  const cachePath = strictFilePath(input.cacheUri)?.replace(/\/+$/u, '');
  const candidatePath = strictFilePath(input.uri);
  if (cachePath === undefined || cachePath === null || candidatePath === null) {
    return false;
  }
  const prefix = `${cachePath}/ImagePicker/`;
  if (!candidatePath.startsWith(prefix)) {
    return false;
  }
  const fileName = candidatePath.slice(prefix.length);
  return fileName.length >= 1
    && fileName.length <= 255
    && !fileName.includes('/');
}

export function deleteOwnedImagePickerCacheFile(
  input: { cacheUri: string; uri: string },
  createFile: (uri: string) => DeletablePickerCacheFile,
): boolean {
  if (!isOwnedImagePickerCacheFile(input)) {
    return false;
  }
  const file = createFile(input.uri);
  if (file.exists) {
    file.delete();
  }
  return true;
}
