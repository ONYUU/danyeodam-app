import { describe, expect, it } from 'vitest';

import { createSessionBindingGenerationController } from './generation';

describe('session and service-binding generation', () => {
  it('invalidates captured work synchronously when the service binding rotates', () => {
    const controller = createSessionBindingGenerationController();
    const captured = controller.current();

    const next = controller.rotateBinding();

    expect(controller.isCurrent(captured)).toBe(false);
    expect(controller.isCurrent(next)).toBe(true);
    expect(next.bindingVersion).toBe(captured.bindingVersion + 1);
  });

  it('uses a distinct auth token for a replacement auth identity', () => {
    const previousAuth = createSessionBindingGenerationController().current();
    const replacementAuth = createSessionBindingGenerationController().current();

    expect(previousAuth.authToken).not.toBe(replacementAuth.authToken);
  });
});
