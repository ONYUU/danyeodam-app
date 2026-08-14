import { describe, expect, it } from 'vitest';

import { mergeUserBlocks } from './page-merge';

const first = { id: 'one', createdAt: '2026-08-12T00:00:00.000Z' };

describe('blocked-user page merge', () => {
  it('deduplicates a stable boundary row and appends new opaque rows', () => {
    expect(mergeUserBlocks([first], [first, {
      id: 'two',
      createdAt: '2026-08-11T00:00:00.000Z',
    }])).toEqual([
      first,
      { id: 'two', createdAt: '2026-08-11T00:00:00.000Z' },
    ]);
  });

  it('rejects conflicting data for an existing opaque ID', () => {
    expect(() => mergeUserBlocks([first], [{
      ...first,
      createdAt: '2026-08-10T00:00:00.000Z',
    }])).toThrow('BLOCK_PAGE_CONFLICT');
  });
});
