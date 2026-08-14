import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createSessionBindingGenerationController } from '@/features/session-data/generation';

describe('location consent logical binding boundary', () => {
  it('remounts and reloads the panel when the logical binding generation rotates', () => {
    const controller = createSessionBindingGenerationController();
    const firstKey = controller.current().id;
    const reboundKey = controller.rotateBinding().id;
    const panel = readFileSync(join(
      process.cwd(),
      'src/features/location-consent/location-consent-panel.tsx',
    ), 'utf8');

    expect(reboundKey).not.toBe(firstKey);
    expect(panel).toContain('key={generation.id}');
    expect(panel).toContain('function LocationConsentPanelForGeneration');
    expect(panel).toContain('void getLocationConsent(controller.signal)');
  });
});
