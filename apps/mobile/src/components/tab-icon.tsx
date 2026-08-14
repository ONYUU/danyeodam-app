import { StyleSheet, Text, type ColorValue } from 'react-native';

interface TabIconProps {
  color: ColorValue;
  glyph: string;
}

export function TabIcon({ color, glyph }: TabIconProps) {
  return (
    <Text
      accessibilityElementsHidden
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={[styles.icon, { color }]}
    >
      {glyph}
    </Text>
  );
}

const styles = StyleSheet.create({
  icon: {
    fontSize: 19,
    fontWeight: '700',
  },
});
