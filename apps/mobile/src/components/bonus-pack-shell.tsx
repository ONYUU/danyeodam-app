import { StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '@/theme/tokens';

type BonusPackShellProps = Readonly<{
  compact?: boolean;
}>;

export function BonusPackShell({ compact = false }: BonusPackShellProps) {
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[styles.root, compact ? styles.rootCompact : null]}
    >
      <View style={styles.innerFrame}>
        <View style={styles.arch} />
        <View style={styles.sun} />
        <View style={styles.hillBack} />
        <View style={styles.hillFront} />
        <View style={styles.titlePlate}>
          <Text style={[styles.brand, compact ? styles.brandCompact : null]}>
            DANYEODAM
          </Text>
          <Text style={[styles.pack, compact ? styles.packCompact : null]}>
            DAILY PACK
          </Text>
        </View>
        <View style={styles.seal}>
          <Text style={styles.sealMark}>D</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    width: '100%',
    aspectRatio: 0.76,
    padding: 7,
    borderRadius: radius.lg,
    backgroundColor: '#B66F70',
    shadowColor: colors.shadow,
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 5,
  },
  rootCompact: {
    borderRadius: radius.md,
    shadowOpacity: 0.11,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  innerFrame: {
    flex: 1,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#F4D9CD',
    borderRadius: 21,
    backgroundColor: '#EBCDC3',
  },
  arch: {
    position: 'absolute',
    top: '8%',
    width: '70%',
    height: '64%',
    borderWidth: 2,
    borderBottomWidth: 0,
    borderColor: '#A65E61',
    borderTopLeftRadius: 160,
    borderTopRightRadius: 160,
    opacity: 0.5,
  },
  sun: {
    position: 'absolute',
    top: '22%',
    width: '27%',
    aspectRatio: 1,
    borderRadius: 999,
    backgroundColor: '#F5E6CF',
  },
  hillBack: {
    position: 'absolute',
    left: '-25%',
    bottom: '-8%',
    width: '96%',
    height: '45%',
    borderRadius: 999,
    backgroundColor: '#C18A83',
    transform: [{ rotate: '-9deg' }],
  },
  hillFront: {
    position: 'absolute',
    right: '-29%',
    bottom: '-14%',
    width: '105%',
    height: '48%',
    borderRadius: 999,
    backgroundColor: '#886B63',
    transform: [{ rotate: '8deg' }],
  },
  titlePlate: {
    alignItems: 'center',
    gap: 7,
    marginTop: '23%',
    paddingHorizontal: 18,
    paddingVertical: 13,
    borderWidth: 1,
    borderColor: '#A65E61',
    borderRadius: radius.sm,
    backgroundColor: '#F8E8DDDB',
  },
  brand: {
    color: '#704B48',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 2.4,
  },
  brandCompact: {
    fontSize: 7,
    letterSpacing: 1.2,
  },
  pack: {
    color: '#9D575B',
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 1.8,
  },
  packCompact: {
    fontSize: 11,
    letterSpacing: 1,
  },
  seal: {
    position: 'absolute',
    bottom: '7%',
    alignItems: 'center',
    justifyContent: 'center',
    width: 38,
    height: 38,
    borderWidth: 2,
    borderColor: '#EBCDC3',
    borderRadius: 19,
    backgroundColor: '#9D575B',
  },
  sealMark: {
    color: '#F8E8DD',
    fontSize: 15,
    fontWeight: '900',
  },
});
