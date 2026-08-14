import type { UserBlock } from '@/api/blocks';

export function mergeUserBlocks(
  current: readonly UserBlock[],
  incoming: readonly UserBlock[],
): readonly UserBlock[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  const merged = [...current];
  for (const item of incoming) {
    const previous = byId.get(item.id);
    if (previous === undefined) {
      byId.set(item.id, item);
      merged.push(item);
    } else if (previous.createdAt !== item.createdAt) {
      throw new Error('BLOCK_PAGE_CONFLICT');
    }
  }
  return merged;
}
