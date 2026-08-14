import { describe, expect, it } from 'vitest';

import {
  requireInviteCode,
  requireRecoveryCode,
  SensitiveCodeInputError,
} from './sensitive-codes';

describe('sensitive code input', () => {
  it('accepts only exact invite and recovery code forms without trimming', () => {
    expect(requireInviteCode('Abcdefghijklmnopqrstuv')).toBe('Abcdefghijklmnopqrstuv');
    expect(requireRecoveryCode('Abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE')).toHaveLength(43);
    expect(() => requireInviteCode(' Abcdefghijklmnopqrstuv')).toThrow(SensitiveCodeInputError);
    expect(() => requireRecoveryCode('short')).toThrow(SensitiveCodeInputError);
  });

  it('never places the submitted code in validation errors', () => {
    const secret = 'secret-code-that-must-not-appear';
    const error = (() => {
      try {
        requireRecoveryCode(secret);
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(String(error)).not.toContain(secret);
  });
});
