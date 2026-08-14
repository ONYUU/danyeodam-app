import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  join(process.cwd(), 'src/features/privacy-rights/privacy-rights-entry.tsx'),
  'utf8',
);

describe('privacy-rights mobile surface', () => {
  it('keeps full withdrawal available when legacy location data has no consent row', () => {
    expect(source).toContain("state.consent.status === 'missing'");
    expect(source).toContain('withdrawLocationConsent()');
  });

  it('renders exact record details with KST timestamps and localized enums', () => {
    expect(source).toContain('formatKstDateTime(fact.collectedAt, locale)');
    expect(source).toContain('formatKstDateTime(fact.decidedAt, locale)');
    expect(source).toContain('formatKstDateTime(correction.requestedAt, locale)');
    expect(source).toContain('formatKstDateTime(correction.resolvedAt, locale)');
    expect(source).toContain('privacyRights.failure.${failureTranslationSuffix(fact.failure)}');
    expect(source).toContain('privacyRights.status.${correction.status}');
  });

  it('announces loading and mutation outcomes to assistive technology', () => {
    expect(source).toContain('accessibilityLabel={label}');
    expect(source.match(/accessibilityLiveRegion="assertive"/gu)?.length).toBeGreaterThanOrEqual(3);
    expect(source).toContain('accessibilityLiveRegion="polite"');
    expect(source).toContain('accessibilityState={{ busy, disabled }}');
  });
});
