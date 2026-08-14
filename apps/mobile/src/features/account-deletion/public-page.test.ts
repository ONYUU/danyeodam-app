import { describe, expect, it } from 'vitest';

import { resolvePublicAccountDeletionUrl } from './public-page';

describe('public account deletion URL', () => {
  it('uses the API origin without copying its path or query', () => {
    expect(resolvePublicAccountDeletionUrl('https://api.example.test/api?secret=no'))
      .toBe('https://api.example.test/account/delete');
    expect(resolvePublicAccountDeletionUrl('http://127.0.0.1:3000/api'))
      .toBe('http://127.0.0.1:3000/account/delete');
  });

  it.each([
    'http://example.test/api',
    'https://user:secret@example.test/api',
    'not-a-url',
  ])('rejects an unsafe public deletion origin', (value) => {
    expect(() => resolvePublicAccountDeletionUrl(value))
      .toThrow('ACCOUNT_DELETION_PUBLIC_URL_INVALID');
  });
});
