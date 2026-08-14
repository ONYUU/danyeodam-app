const INVITE_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const RECOVERY_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type SensitiveCodeKind = 'invite' | 'recovery';

export class SensitiveCodeInputError extends Error {
  readonly kind: SensitiveCodeKind;

  constructor(kind: SensitiveCodeKind) {
    super('Sensitive code input is invalid.');
    this.name = 'SensitiveCodeInputError';
    this.kind = kind;
  }
}

export function requireInviteCode(value: string): string {
  if (!INVITE_CODE_PATTERN.test(value)) {
    throw new SensitiveCodeInputError('invite');
  }
  return value;
}

export function requireRecoveryCode(value: string): string {
  if (!RECOVERY_CODE_PATTERN.test(value)) {
    throw new SensitiveCodeInputError('recovery');
  }
  return value;
}
