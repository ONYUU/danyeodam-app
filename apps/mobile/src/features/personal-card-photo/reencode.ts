import {
  PERSONAL_CARD_JPEG_QUALITY,
  PersonalCardSelectionError,
  type PersonalCardResize,
  type SanitizedPersonalCardPhoto,
} from './selection';

export type PersonalCardReencodeDependencies<Format> = {
  jpegFormat: Format;
  manipulate(uri: string): {
    release(): void;
    resize(size: { width?: number; height?: number }): unknown;
    renderAsync(): Promise<{
      release(): void;
      saveAsync(options: {
        base64: false;
        compress: number;
        format: Format;
      }): Promise<{ uri: string; width: number; height: number }>;
    }>;
  };
  readAndDelete(uri: string): Promise<Uint8Array<ArrayBuffer>>;
};

export async function reencodePersonalCardPhoto<Format>(
  input: {
    uri: string;
    resize: PersonalCardResize;
    signal: AbortSignal;
  },
  dependencies: PersonalCardReencodeDependencies<Format>,
): Promise<SanitizedPersonalCardPhoto> {
  if (input.signal.aborted) {
    throw new PersonalCardSelectionError('ABORTED');
  }
  const context = dependencies.manipulate(input.uri);
  let image: Awaited<ReturnType<typeof context.renderAsync>> | null = null;
  try {
    if (input.resize !== null) {
      context.resize(input.resize);
    }
    image = await context.renderAsync();
    if (input.signal.aborted) {
      throw new PersonalCardSelectionError('ABORTED');
    }
    const result = await image.saveAsync({
      base64: false,
      compress: PERSONAL_CARD_JPEG_QUALITY,
      format: dependencies.jpegFormat,
    });
    const bytes = await dependencies.readAndDelete(result.uri);
    if (input.signal.aborted) {
      bytes.fill(0);
      throw new PersonalCardSelectionError('ABORTED');
    }
    return {
      bytes,
      contentType: 'image/jpeg',
      width: result.width,
      height: result.height,
    };
  } finally {
    image?.release();
    context.release();
  }
}
