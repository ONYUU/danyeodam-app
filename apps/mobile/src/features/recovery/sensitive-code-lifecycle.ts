export function createSensitiveCodeLifecycle() {
  let secretVisible = false;
  let redactionPending = false;

  return {
    markSecretVisible(): void {
      secretVisible = true;
      redactionPending = false;
    },
    requestRedaction(): void {
      if (secretVisible) {
        secretVisible = false;
        redactionPending = true;
      }
    },
    commitRedactedUi(releaseProtection: () => void): void {
      if (!secretVisible && redactionPending) {
        redactionPending = false;
        releaseProtection();
      }
    },
    leaveScreen(releaseProtection: () => void): void {
      secretVisible = false;
      redactionPending = false;
      releaseProtection();
    },
  };
}

export type SensitiveCodeLifecycle = ReturnType<
  typeof createSensitiveCodeLifecycle
>;
