import type { StyleProp, ViewStyle } from 'react-native';
import { StyleSheet, Text, View } from 'react-native';

import { colors } from '@/theme/tokens';

import { CardArtwork } from './card-artwork';

export const TRAVEL_CARD_ASPECT_RATIO = 63 / 88;

type TravelCardVariant = 'compact' | 'standard' | 'hero';

type TravelCardFaceProps = {
  imageUrl: string | null;
  colorHex: string;
  title: string;
  acquired?: boolean;
  variant?: TravelCardVariant;
  style?: StyleProp<ViewStyle>;
};

const rootStyleByVariant: Record<TravelCardVariant, ViewStyle> = {
  compact: {
    borderRadius: 12,
    shadowOpacity: 0.12,
    shadowRadius: 7,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  standard: {
    borderRadius: 16,
    shadowOpacity: 0.14,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 7 },
    elevation: 3,
  },
  hero: {
    borderRadius: 22,
    shadowOpacity: 0.18,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 12 },
    elevation: 5,
  },
};

const surfaceStyleByVariant: Record<TravelCardVariant, ViewStyle> = {
  compact: { borderRadius: 12, borderWidth: 1 },
  standard: { borderRadius: 16, borderWidth: 1.5 },
  hero: { borderRadius: 22, borderWidth: 2 },
};

export function TravelCardFace({
  imageUrl,
  colorHex,
  title,
  acquired = false,
  variant = 'standard',
  style,
}: TravelCardFaceProps) {
  const compact = variant === 'compact';
  const hero = variant === 'hero';

  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[
        styles.root,
        rootStyleByVariant[variant],
        style,
        styles.fixedAspectRatio,
      ]}
    >
      <View
        style={[
          styles.surface,
          surfaceStyleByVariant[variant],
          acquired ? styles.surfaceAcquired : null,
        ]}
      >
        <View style={styles.artworkRegion}>
          <CardArtwork
            borderRadius={0}
            colorHex={colorHex}
            fill
            imageUrl={imageUrl}
          />
          <View style={styles.artworkWash} />
        </View>

        <View style={[
          styles.footer,
          compact ? styles.footerCompact : null,
          hero ? styles.footerHero : null,
          acquired ? styles.footerAcquired : null,
          acquired && compact ? styles.footerAcquiredCompact : null,
        ]}>
          <View style={styles.metaRow}>
            <Text style={[
              styles.brand,
              compact ? styles.brandCompact : null,
              hero ? styles.brandHero : null,
            ]}>
              DANYEODAM
            </Text>
            <Text style={[
              styles.kind,
              compact ? styles.kindCompact : null,
              hero ? styles.kindHero : null,
            ]}>
              PLACE
            </Text>
          </View>
          <View style={[styles.footerRule, { backgroundColor: colorHex }]} />
          <Text
            adjustsFontSizeToFit
            minimumFontScale={0.78}
            numberOfLines={2}
            style={[
              styles.title,
              compact ? styles.titleCompact : null,
              hero ? styles.titleHero : null,
            ]}
          >
            {title}
          </Text>
        </View>

        <View style={styles.routeLayer}>
          <View style={[
            styles.routeSegmentA,
            compact ? styles.routeSegmentACompact : null,
          ]} />
          <View style={[
            styles.routeSegmentB,
            compact ? styles.routeSegmentBCompact : null,
          ]} />
          <View style={[
            styles.routeSegmentC,
            compact ? styles.routeSegmentCCompact : null,
          ]} />
          <View style={[styles.routeDotStart, { backgroundColor: colorHex }]} />
          <View style={[styles.routeDotMiddle, { backgroundColor: colorHex }]} />
          <View style={[
            styles.visitMarker,
            compact ? styles.visitMarkerCompact : null,
            hero ? styles.visitMarkerHero : null,
            acquired ? styles.visitMarkerAcquired : null,
          ]}>
            <View style={[
              styles.visitMarkerCore,
              compact ? styles.visitMarkerCoreCompact : null,
              hero ? styles.visitMarkerCoreHero : null,
              { backgroundColor: acquired ? colors.cardGold : colorHex },
            ]} />
          </View>
        </View>

        <View style={[
          styles.fold,
          compact ? styles.foldCompact : null,
          hero ? styles.foldHero : null,
          { borderBottomColor: colorHex },
        ]} />
        <View style={[
          styles.foldEdge,
          compact ? styles.foldEdgeCompact : null,
          hero ? styles.foldEdgeHero : null,
        ]} />

        {acquired ? (
          <View style={[
            styles.acquiredStamp,
            compact ? styles.acquiredStampCompact : null,
            hero ? styles.acquiredStampHero : null,
          ]}>
            <Text style={[
              styles.acquiredStampMark,
              compact ? styles.acquiredStampMarkCompact : null,
              hero ? styles.acquiredStampMarkHero : null,
            ]}>
              ✓
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    width: '100%',
    shadowColor: colors.shadow,
    backgroundColor: colors.cardIvory,
  },
  fixedAspectRatio: {
    aspectRatio: TRAVEL_CARD_ASPECT_RATIO,
  },
  surface: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    overflow: 'hidden',
    borderColor: colors.cardIvoryDeep,
    backgroundColor: colors.cardIvory,
  },
  surfaceAcquired: {
    borderColor: colors.cardGold,
  },
  artworkRegion: {
    flex: 66,
    overflow: 'hidden',
    backgroundColor: colors.paperStrong,
  },
  artworkWash: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: '#2C28220A',
  },
  footer: {
    flex: 34,
    justifyContent: 'flex-start',
    paddingHorizontal: 14,
    paddingTop: 13,
    paddingBottom: 12,
    backgroundColor: colors.cardIvory,
  },
  footerCompact: {
    paddingHorizontal: 7,
    paddingTop: 7,
    paddingBottom: 6,
  },
  footerHero: {
    paddingHorizontal: 22,
    paddingTop: 20,
    paddingBottom: 18,
  },
  footerAcquired: {
    paddingRight: 48,
  },
  footerAcquiredCompact: {
    paddingRight: 26,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  brand: {
    flexShrink: 1,
    color: colors.mutedInk,
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1.35,
  },
  brandCompact: {
    fontSize: 5.5,
    letterSpacing: 0.65,
  },
  brandHero: {
    fontSize: 11,
    letterSpacing: 2,
  },
  kind: {
    color: colors.stamp,
    fontSize: 7,
    fontWeight: '800',
    letterSpacing: 1.1,
  },
  kindCompact: {
    fontSize: 5,
    letterSpacing: 0.5,
  },
  kindHero: {
    fontSize: 10,
    letterSpacing: 1.6,
  },
  footerRule: {
    width: '31%',
    height: 2,
    marginTop: 7,
    marginBottom: 8,
    borderRadius: 2,
  },
  title: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: -0.25,
    lineHeight: 17,
  },
  titleCompact: {
    fontSize: 8.5,
    letterSpacing: -0.1,
    lineHeight: 10.5,
  },
  titleHero: {
    fontSize: 21,
    letterSpacing: -0.45,
    lineHeight: 27,
  },
  routeLayer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  routeSegmentA: {
    position: 'absolute',
    top: '9%',
    right: '11%',
    width: '28%',
    height: '17%',
    borderTopWidth: 2,
    borderLeftWidth: 2,
    borderColor: colors.cardRoute,
    borderTopLeftRadius: 18,
    transform: [{ rotate: '-8deg' }],
  },
  routeSegmentACompact: {
    borderTopWidth: 1,
    borderLeftWidth: 1,
  },
  routeSegmentB: {
    position: 'absolute',
    top: '24%',
    right: '27%',
    width: '34%',
    height: '22%',
    borderLeftWidth: 2,
    borderBottomWidth: 2,
    borderColor: colors.cardRoute,
    borderBottomLeftRadius: 22,
    transform: [{ rotate: '7deg' }],
  },
  routeSegmentBCompact: {
    borderLeftWidth: 1,
    borderBottomWidth: 1,
  },
  routeSegmentC: {
    position: 'absolute',
    top: '44%',
    left: '38%',
    width: '18%',
    height: '20%',
    borderTopWidth: 2,
    borderRightWidth: 2,
    borderColor: colors.cardRoute,
    borderTopRightRadius: 18,
    transform: [{ rotate: '-10deg' }],
  },
  routeSegmentCCompact: {
    borderTopWidth: 1,
    borderRightWidth: 1,
  },
  routeDotStart: {
    position: 'absolute',
    top: '8%',
    right: '8%',
    width: 8,
    height: 8,
    borderWidth: 2,
    borderColor: colors.cardRoute,
    borderRadius: 4,
  },
  routeDotMiddle: {
    position: 'absolute',
    top: '35%',
    right: '6.5%',
    width: 7,
    height: 7,
    borderWidth: 2,
    borderColor: colors.cardRoute,
    borderRadius: 4,
  },
  visitMarker: {
    position: 'absolute',
    top: '4.5%',
    left: '4.5%',
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.cardIvory,
    borderRadius: 12,
    backgroundColor: colors.cardIvory,
    shadowColor: colors.shadow,
    shadowOpacity: 0.2,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  visitMarkerCompact: {
    width: 14,
    height: 14,
    borderWidth: 1,
    borderRadius: 7,
  },
  visitMarkerHero: {
    width: 34,
    height: 34,
    borderWidth: 3,
    borderRadius: 17,
  },
  visitMarkerAcquired: {
    borderColor: colors.cardGoldSoft,
  },
  visitMarkerCore: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  visitMarkerCoreCompact: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  visitMarkerCoreHero: {
    width: 15,
    height: 15,
    borderRadius: 8,
  },
  fold: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    width: 0,
    height: 0,
    borderBottomWidth: 28,
    borderRightWidth: 28,
    borderRightColor: 'transparent',
  },
  foldCompact: {
    borderBottomWidth: 17,
    borderRightWidth: 17,
  },
  foldHero: {
    borderBottomWidth: 40,
    borderRightWidth: 40,
  },
  foldEdge: {
    position: 'absolute',
    bottom: 13,
    left: -6,
    width: 31,
    height: 1,
    backgroundColor: colors.cardIvory,
    opacity: 0.75,
    transform: [{ rotate: '-45deg' }],
  },
  foldEdgeCompact: {
    bottom: 8,
    left: -4,
    width: 19,
  },
  foldEdgeHero: {
    bottom: 19,
    left: -9,
    width: 44,
    height: 2,
  },
  acquiredStamp: {
    position: 'absolute',
    right: 12,
    bottom: 11,
    width: 27,
    height: 27,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.cardGold,
    borderRadius: 14,
    opacity: 0.72,
    transform: [{ rotate: '-9deg' }],
  },
  acquiredStampCompact: {
    right: 6,
    bottom: 5,
    width: 16,
    height: 16,
    borderWidth: 1,
    borderRadius: 8,
  },
  acquiredStampHero: {
    right: 19,
    bottom: 17,
    width: 39,
    height: 39,
    borderWidth: 2,
    borderRadius: 20,
  },
  acquiredStampMark: {
    color: colors.cardGold,
    fontSize: 13,
    fontWeight: '800',
  },
  acquiredStampMarkCompact: {
    fontSize: 8,
  },
  acquiredStampMarkHero: {
    fontSize: 20,
  },
});
