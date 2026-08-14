import type { OpenedBonusPack } from '@/api/bonus-packs';
import type { SupportedLocale } from '@/i18n/locales';

export function createBonusPackOpenOperation(dependencies: {
  createClientRequestId(): string;
  open(input: {
    packId: string;
    clientRequestId: string;
    locale: SupportedLocale;
    signal: AbortSignal;
  }): Promise<OpenedBonusPack>;
}) {
  let boundPackId: string | null = null;
  let clientRequestId: string | null = null;

  return {
    reset(packId: string): void {
      if (boundPackId !== packId) {
        boundPackId = packId;
        clientRequestId = null;
      }
    },
    async run(input: {
      packId: string;
      locale: SupportedLocale;
      signal: AbortSignal;
    }): Promise<OpenedBonusPack> {
      if (boundPackId !== input.packId) {
        boundPackId = input.packId;
        clientRequestId = null;
      }
      clientRequestId ??= dependencies.createClientRequestId();
      return dependencies.open({ ...input, clientRequestId });
    },
  };
}
