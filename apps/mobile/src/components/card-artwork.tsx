import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '@/theme/tokens';

type CardArtworkProps = {
  imageUrl: string | null;
  colorHex: string;
  requestHeaders?: Record<string, string>;
  requestVersion?: number;
  onLoadError?: () => void;
  height?: number;
  fill?: boolean;
  borderRadius?: number;
  resizeMode?: 'cover' | 'contain';
};

export function CardArtwork({
  imageUrl,
  colorHex,
  requestHeaders,
  requestVersion = 0,
  onLoadError,
  height = 150,
  fill = false,
  borderRadius = radius.sm,
  resizeMode = 'cover',
}: CardArtworkProps) {
  const requestIdentity = imageUrl === null ? null : `${imageUrl}:${requestVersion}`;
  const [failedRequestIdentity, setFailedRequestIdentity] = useState<string | null>(null);
  const failed = requestIdentity !== null && failedRequestIdentity === requestIdentity;

  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.frame,
        fill ? styles.fill : { height },
        { backgroundColor: colorHex, borderRadius },
      ]}
    >
      {imageUrl !== null && !failed ? (
        <Image
          onError={() => {
            setFailedRequestIdentity(requestIdentity);
            onLoadError?.();
          }}
          resizeMode={resizeMode}
          source={{
            uri: imageUrl,
            ...(requestHeaders === undefined ? {} : {
              cache: 'reload' as const,
              headers: requestHeaders,
            }),
          }}
          style={styles.image}
        />
      ) : (
        <View style={styles.fallback}>
          <View style={[styles.sun, { borderColor: colorHex }]} />
          <View style={[styles.horizonBack, { backgroundColor: colorHex }]} />
          <View style={styles.horizonFront} />
          <Text style={[styles.mark, { color: colorHex }]}>D</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    overflow: 'hidden',
  },
  fill: {
    flex: 1,
    height: '100%',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  fallback: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: colors.paperStrong,
  },
  sun: {
    position: 'absolute',
    top: 22,
    right: 24,
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 7,
    backgroundColor: colors.cardIvory,
  },
  horizonBack: {
    position: 'absolute',
    left: -34,
    bottom: -64,
    width: 225,
    height: 146,
    borderRadius: 112,
    opacity: 0.78,
    transform: [{ rotate: '-7deg' }],
  },
  horizonFront: {
    position: 'absolute',
    right: -48,
    bottom: -84,
    width: 230,
    height: 152,
    borderRadius: 115,
    backgroundColor: '#75907D',
    opacity: 0.82,
    transform: [{ rotate: '8deg' }],
  },
  mark: {
    position: 'absolute',
    left: 18,
    bottom: 14,
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 1,
  },
});
