import { Tabs } from 'expo-router';

import { TabIcon } from '@/components/tab-icon';
import { useI18n } from '@/i18n/locale-provider';
import { colors } from '@/theme/tokens';

export default function TabsLayout() {
  const { t } = useI18n();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: colors.paper },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.mutedInk,
        tabBarStyle: {
          backgroundColor: colors.white,
          borderTopColor: colors.border,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t('tabs.home'),
          tabBarIcon: ({ color }) => <TabIcon color={color} glyph="⌂" />,
        }}
      />
      <Tabs.Screen
        name="collection"
        options={{
          title: t('tabs.collection'),
          tabBarIcon: ({ color }) => <TabIcon color={color} glyph="▧" />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t('tabs.settings'),
          tabBarIcon: ({ color }) => <TabIcon color={color} glyph="●" />,
        }}
      />
    </Tabs>
  );
}
