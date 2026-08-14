import { useState } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { StyleSheet, Text, View } from 'react-native';

import { colors } from '@/theme/tokens';

import { CardArtwork } from './card-artwork';
import { TRAVEL_CARD_ASPECT_RATIO } from './travel-card-face';

type SpecialCardFaceProps = Readonly<{
  imageUrl: string | null;
  imageAuthorization: string | null;
  imageRequestVersion: number;
  colorHex: string;
  artPendingLabel?: string;
  style?: StyleProp<ViewStyle>;
}>;

export function SpecialCardFace({
  imageUrl,
  imageAuthorization,
  imageRequestVersion,
  colorHex,
  artPendingLabel,
  style,
}: SpecialCardFaceProps) {
  const requestIdentity = imageUrl === null
    ? null
    : `${imageUrl}:${imageRequestVersion}`;
  const [failedRequestIdentity, setFailedRequestIdentity] = useState<string | null>(null);
  const unavailable = imageUrl === null
    || imageAuthorization === null
    || failedRequestIdentity === requestIdentity;

  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[styles.root, style]}
    >
      {unavailable ? (
        <View style={styles.pendingFace}>
          <View style={[styles.pendingSeal, { borderColor: colorHex }]}>
            <Text style={[styles.pendingMark, { color: colorHex }]}>D</Text>
          </View>
          {artPendingLabel === undefined ? null : (
            <Text style={styles.pendingLabel}>{artPendingLabel}</Text>
          )}
        </View>
      ) : (
        <View style={styles.approvedFace}>
          <CardArtwork
            borderRadius={20}
            colorHex={colorHex}
            fill
            imageUrl={imageUrl}
            onLoadError={() => setFailedRequestIdentity(requestIdentity)}
            requestVersion={imageRequestVersion}
            resizeMode="contain"
            {...(imageAuthorization === null
              ? {}
              : { requestHeaders: { Authorization: `Bearer ${imageAuthorization}` } })}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    width: '100%',
    aspectRatio: TRAVEL_CARD_ASPECT_RATIO,
    borderRadius: 22,
    backgroundColor: '#2F2A29',
    shadowColor: colors.shadow,
    shadowOpacity: 0.24,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 12 },
    elevation: 6,
  },
  approvedFace: {
    flex: 1,
    overflow: 'hidden',
    borderRadius: 22,
    backgroundColor: '#2F2A29',
  },
  pendingFace: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
    paddingHorizontal: 24,
    overflow: 'hidden',
    borderRadius: 22,
    backgroundColor: colors.paperStrong,
  },
  pendingSeal: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 56,
    height: 56,
    borderWidth: 2,
    borderRadius: 28,
    backgroundColor: colors.cardIvory,
  },
  pendingMark: {
    fontSize: 19,
    fontWeight: '900',
    letterSpacing: 1,
  },
  pendingLabel: {
    color: colors.mutedInk,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 18,
    textAlign: 'center',
  },
});
