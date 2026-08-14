import { describe, expect, it, vi } from 'vitest';

import { createSensitiveCodeLifecycle } from './sensitive-code-lifecycle';

describe('recovery code screen-protection lifecycle', () => {
  it('keeps protection through background redaction and releases after its UI commit', () => {
    const releaseProtection = vi.fn();
    const lifecycle = createSensitiveCodeLifecycle();
    lifecycle.markSecretVisible();

    lifecycle.requestRedaction();
    expect(releaseProtection).not.toHaveBeenCalled();

    lifecycle.commitRedactedUi(releaseProtection);
    expect(releaseProtection).toHaveBeenCalledOnce();
  });

  it('does not release a replacement secret from a stale redaction commit', () => {
    const releaseProtection = vi.fn();
    const lifecycle = createSensitiveCodeLifecycle();
    lifecycle.markSecretVisible();
    lifecycle.requestRedaction();

    lifecycle.markSecretVisible();
    lifecycle.commitRedactedUi(releaseProtection);

    expect(releaseProtection).not.toHaveBeenCalled();
  });

  it('always releases when the recovery screen is left or unmounted', () => {
    const releaseProtection = vi.fn();
    const lifecycle = createSensitiveCodeLifecycle();
    lifecycle.markSecretVisible();

    lifecycle.leaveScreen(releaseProtection);

    expect(releaseProtection).toHaveBeenCalledOnce();
  });
});
