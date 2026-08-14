import * as Haptics from 'expo-haptics';

export async function playBonusPackRevealHaptic(enabled: boolean): Promise<void> {
  if (!enabled) return;
  await Haptics.notificationAsync(
    Haptics.NotificationFeedbackType.Success,
  ).catch(() => undefined);
}
