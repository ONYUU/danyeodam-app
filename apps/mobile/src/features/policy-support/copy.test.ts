import { describe, expect, it } from 'vitest';

import { SUPPORTED_LOCALES } from '@/i18n/locales';

import { policySupportCopy } from './copy';

describe('policy and support translations', () => {
  it('keeps every label complete in all six locales', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const values = Object.values(policySupportCopy(locale));
      expect(values.every((value) => value.trim().length > 0)).toBe(true);
      expect(policySupportCopy(locale).verificationBody).toMatch(/SHA-256/iu);
    }
  });
});
