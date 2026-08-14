import type { PropsWithChildren } from 'react';
import { ScrollView, StyleSheet, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing } from '@/theme/tokens';

interface ScreenProps extends PropsWithChildren {
  contentStyle?: ViewStyle;
}

export function Screen({ children, contentStyle }: ScreenProps) {
  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[styles.content, contentStyle]}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  content: {
    flexGrow: 1,
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
  },
});
