export const DEFAULT_REVEAL_HAPTICS_ENABLED = true;

export type HapticPreferenceBackend = Readonly<{
  getItem(): Promise<string | null>;
  setItem(value: string): Promise<void>;
}>;

export function parseStoredHapticPreference(value: string | null): boolean {
  if (value === 'enabled') return true;
  if (value === 'disabled') return false;
  return DEFAULT_REVEAL_HAPTICS_ENABLED;
}

export function createHapticPreferenceStorage(
  backend: HapticPreferenceBackend,
) {
  return {
    async load(): Promise<boolean> {
      return parseStoredHapticPreference(await backend.getItem());
    },
    async save(enabled: boolean): Promise<void> {
      await backend.setItem(enabled ? 'enabled' : 'disabled');
    },
  };
}
