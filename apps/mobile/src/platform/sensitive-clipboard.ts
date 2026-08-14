export const RECOVERY_CLIPBOARD_CLEAR_MS = 60_000;

export type ClipboardDependencies = {
  getString(): Promise<string>;
  setString(value: string): Promise<unknown>;
};

export function scheduleClearIfClipboardUnchanged(
  sensitiveValue: string,
  dependencies: ClipboardDependencies,
  delayMs = RECOVERY_CLIPBOARD_CLEAR_MS,
): void {
  setTimeout(() => {
    void dependencies.getString().then((currentValue) => {
      if (currentValue === sensitiveValue) {
        return dependencies.setString('');
      }
      return undefined;
    }).catch(() => undefined);
  }, delayMs);
}
