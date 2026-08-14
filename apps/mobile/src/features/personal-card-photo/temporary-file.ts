export type TemporaryImageFile = {
  bytes(): Promise<Uint8Array<ArrayBuffer>>;
  delete(): void;
  exists: boolean;
};

export async function readTemporaryImageBytesAndDelete(
  file: TemporaryImageFile,
): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return await file.bytes();
  } finally {
    if (file.exists) {
      file.delete();
    }
  }
}
