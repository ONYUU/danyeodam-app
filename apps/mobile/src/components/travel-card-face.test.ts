import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

async function source(relativePath: string) {
  return readFile(new URL(relativePath, import.meta.url), 'utf8');
}

describe('Danyeodam travel card face', () => {
  it('keeps the physical-card ratio and Danyeodam place identity', async () => {
    const card = await source('./travel-card-face.tsx');

    expect(card).toContain('TRAVEL_CARD_ASPECT_RATIO = 63 / 88');
    expect(card).toContain('aspectRatio: TRAVEL_CARD_ASPECT_RATIO');
    expect(card).toContain('DANYEODAM');
    expect(card).toContain('PLACE');
    expect(card).not.toMatch(/cardbook|rarity|serial|\d{3,}\s*\/\s*\d{3,}/iu);
  });

  it('uses one route motif, a visit marker, and a folded-map corner', async () => {
    const card = await source('./travel-card-face.tsx');

    expect(card).toContain('styles.routeSegmentA');
    expect(card).toContain('styles.routeSegmentB');
    expect(card).toContain('styles.routeSegmentC');
    expect(card).toContain('styles.routeDotStart');
    expect(card).toContain('styles.visitMarker');
    expect(card).toContain('styles.fold');
    expect(card).toContain('styles.foldEdge');
    expect(card).toContain("top: '4.5%'");
    expect(card).toContain("left: '4.5%'");
    expect(card).toContain('bottom: 0');
    expect(card).toContain('left: 0');
  });

  it('limits acquired-state decoration to the gold border, marker, and stamp', async () => {
    const [card, tokens] = await Promise.all([
      source('./travel-card-face.tsx'),
      source('../theme/tokens.ts'),
    ]);

    expect(card).toContain('acquired ? styles.surfaceAcquired : null');
    expect(card).toContain('acquired ? styles.visitMarkerAcquired : null');
    expect(card).toContain('styles.acquiredStamp');
    expect(tokens).toContain("cardGold: '#B48A43'");
    expect(tokens).toContain("cardIvory: '#FBF4E4'");
  });

  it('remains decorative inside existing accessible summaries and actions', async () => {
    const [card, spotList, collection, detail, acquire] = await Promise.all([
      source('./travel-card-face.tsx'),
      source('./spot-list-item.tsx'),
      source('./collection-item-card.tsx'),
      source('../app/spot/[id].tsx'),
      source('../features/acquire/acquire-panel.tsx'),
    ]);

    expect(card).toContain('accessible={false}');
    expect(card).toContain('importantForAccessibility="no-hide-descendants"');
    expect(spotList).toContain('accessibilityLabel={`${spotName}. ${regionName}. ${status}. ${cardTitle}`}');
    expect(collection).toContain('accessibilityLabel={`${title}. ${spotName}. ${typeLabel}. ${date}.${personalCardLabel}`}');
    expect(detail).toContain('accessibilityLabel={`${cardTitle}. PLACE.`}');
    expect(acquire).toContain('accessibilityLabel={`${title}. ${t(\'acquire.dateLabel\')} ${date}`}');
  });

  it('uses the same face for browse, detail, collection, and acquisition success', async () => {
    const consumers = await Promise.all([
      source('./spot-list-item.tsx'),
      source('./collection-item-card.tsx'),
      source('../app/spot/[id].tsx'),
      source('../features/acquire/acquire-panel.tsx'),
    ]);

    for (const consumer of consumers) {
      expect(consumer).toContain('<TravelCardFace');
      expect(consumer).not.toContain('<CardArtwork');
    }
    expect(consumers[1]).toContain('acquired');
    expect(consumers[1]).toContain('variant="compact"');
    expect(consumers[3]).toContain('acquired');
  });
});
