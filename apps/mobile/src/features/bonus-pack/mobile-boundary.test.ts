import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

async function source(relativePath: string) {
  return readFile(new URL(relativePath, import.meta.url), 'utf8');
}

describe('bonus pack mobile boundary', () => {
  it('keeps the existing three tabs and opens pack flows from Cards', async () => {
    const [tabs, collection, entry] = await Promise.all([
      source('../../app/(tabs)/_layout.tsx'),
      source('../../app/(tabs)/collection.tsx'),
      source('./bonus-pack-entry-card.tsx'),
    ]);
    expect(tabs.match(/<Tabs\.Screen/gu)).toHaveLength(3);
    expect(collection).toContain('<BonusPackEntryCard />');
    expect(collection).toContain('<InventoryEntryCard />');
    expect(collection).toContain("t('collection.visitsTitle')");
    expect(entry).toContain('state.sealedCount');
    expect(entry).toContain("state.status === 'error'");
    expect(entry).toContain("t('common.errorTitle')");
    expect(entry).not.toContain("filter(({ status }) => status === 'sealed')");
  });

  it('contains no bundled special artwork, audio, BGM, or autoplay path', async () => {
    const [special, detail, shell] = await Promise.all([
      source('../../components/special-card-face.tsx'),
      source('./bonus-pack-detail-screen.tsx'),
      source('../../components/bonus-pack-shell.tsx'),
    ]);
    const combined = `${special}\n${detail}\n${shell}`;
    expect(combined).not.toMatch(/require\(.+\.(?:png|jpe?g|webp|mp3|wav|m4a)/iu);
    expect(combined).not.toMatch(/Audio|expo-av|BGM|autoplay|playAsync/iu);
    expect(special).toContain('<CardArtwork');
    expect(special).toContain('resizeMode="contain"');
    expect(special).toContain('imageUrl={imageUrl}');
    expect(special).toContain('failedRequestIdentity === requestIdentity');
    expect(special).not.toContain('COLLECTOR PLACE CARD');
    expect(special).not.toContain('outerFrame');
    expect(special).not.toContain('rarityLabel');
    expect(special).not.toContain('title: string');
    expect(special).not.toContain('resizeMode="cover"');
  });

  it('reveals only after the server response and respects reduced motion', async () => {
    const [detail, reducedMotion, haptics] = await Promise.all([
      source('./bonus-pack-detail-screen.tsx'),
      source('./use-reduced-motion.ts'),
      source('./reveal-haptics.ts'),
    ]);
    const afterServerResult = detail.slice(detail.indexOf('await openOperation.run'));
    expect(afterServerResult.indexOf('setRevealVersion')).toBeGreaterThan(0);
    expect(afterServerResult.indexOf('playBonusPackRevealHaptic')).toBeGreaterThan(0);
    expect(detail).toContain("openState === 'error'");
    expect(detail).toContain("state.pack.status !== 'sealed'");
    expect(detail).toContain('!haptics.loading && !haptics.error && haptics.enabled');
    const sealedScreen = detail.slice(detail.indexOf('function SealedPack'));
    expect(sealedScreen.indexOf('<BonusPackRulesCard />')).toBeLessThan(
      sealedScreen.indexOf("{t(openState === 'submitting'"),
    );
    expect(reducedMotion).toContain('AccessibilityInfo.isReduceMotionEnabled');
    expect(reducedMotion).toContain("'reduceMotionChanged'");
    expect(reducedMotion).toContain('useState(true)');
    expect(haptics).toContain('if (!enabled) return');
  });

  it('announces rarity in text and marks decorative card internals hidden', async () => {
    const [detail, special, pack] = await Promise.all([
      source('./bonus-pack-detail-screen.tsx'),
      source('../../components/special-card-face.tsx'),
      source('../../components/bonus-pack-shell.tsx'),
    ]);
    expect(detail).toContain("'bonusPack.raritySpecial'");
    expect(detail).toContain('accessibilityLiveRegion');
    expect(detail).toContain('accessibilityLabel={`${rarityLabel}. ${title}.`}');
    expect(detail).toContain('AccessibilityInfo.setAccessibilityFocus(node)');
    expect(detail).toContain('findNodeHandle(resultHeadingRef.current)');
    expect(detail).toContain('if (!focusResult || revealVersion === 0) return undefined');
    expect(detail).toContain('reducedMotion ? 0 : 900');
    expect(detail).toContain('setFocusResult(false)');
    expect(detail).toContain('setFocusResult(true)');
    for (const decorative of [special, pack]) {
      expect(decorative).toContain('accessible={false}');
      expect(decorative).toContain('importantForAccessibility="no-hide-descendants"');
    }
  });

  it('loads special art only from the current in-memory bearer session', async () => {
    const [artwork, special, detail, inventory] = await Promise.all([
      source('../../components/card-artwork.tsx'),
      source('../../components/special-card-face.tsx'),
      source('./bonus-pack-detail-screen.tsx'),
      source('./card-inventory-screen.tsx'),
    ]);
    expect(artwork).toContain('headers: requestHeaders');
    expect(artwork).toContain("cache: 'reload'");
    expect(special).toContain('Authorization: `Bearer ${imageAuthorization}`');
    expect(detail).toContain('auth.session?.access_token ?? null');
    expect(inventory).toContain('auth.session?.access_token ?? null');
    const combined = `${artwork}\n${special}\n${detail}\n${inventory}`;
    expect(combined).not.toMatch(/console\.|SecureStore|localStorage|sessionStorage/gu);
  });

  it('uses one non-looping high-rarity burst after the server result', async () => {
    const detail = await source('./bonus-pack-detail-screen.tsx');
    const afterServerResult = detail.slice(detail.indexOf('await openOperation.run'));
    expect(afterServerResult).toContain("setRevealedRarity(pack.card.rarity)");
    expect(detail).toContain('duration: special ? 850 : 420');
    expect(detail).toContain('Animated.parallel');
    expect(detail).toContain('<SpecialRevealEffect progress={specialEffectProgress} />');
    expect(detail).toContain('<SpecialRevealShine progress={specialEffectProgress} />');
    expect(detail).toContain('styles.goldRingOuter');
    expect(detail).toContain('styles.goldParticle');
    expect(detail).toContain("outputRange: [special ? 22 : 8, 0]");
    expect(detail).not.toMatch(/Animated\.(?:loop|repeat)|strobe|blink/iu);
  });
});
