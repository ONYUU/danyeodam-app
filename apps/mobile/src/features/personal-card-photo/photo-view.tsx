import { useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useAuth } from '@/auth/auth-provider';
import { useI18n } from '@/i18n/locale-provider';
import { colors, radius, spacing } from '@/theme/tokens';

import { useOwnedPersonalCardPhoto } from './use-owned-photo';

export function PersonalCardPhotoView(input: {
  personalCardId: string;
  photoPath: string;
}) {
  const auth = useAuth();
  const { t } = useI18n();
  const sessionVersion = auth.session?.expires_at ?? 0;
  const { state, retry } = useOwnedPersonalCardPhoto({
    enabled: auth.status === 'ready' && auth.session !== null,
    personalCardId: input.personalCardId,
    photoPath: input.photoPath,
    sessionVersion,
  });
  const [decodeFailureUrl, setDecodeFailureUrl] = useState<string | null>(null);
  const decodeFailed = state.status === 'ready'
    && decodeFailureUrl === state.objectUrl;

  if (state.status === 'ready' && !decodeFailed) {
    return (
      <Image
        accessibilityLabel={t('personalCardPhoto.imageLabel')}
        onError={() => setDecodeFailureUrl(state.objectUrl)}
        resizeMode="cover"
        source={{ uri: state.objectUrl }}
        style={styles.image}
      />
    );
  }

  return (
    <View style={styles.state}>
      {state.status === 'loading' || state.status === 'idle' ? (
        <>
          <ActivityIndicator color={colors.accent} size="small" />
          <Text style={styles.stateText}>{t('personalCardPhoto.loading')}</Text>
        </>
      ) : (
        <>
          <Text accessibilityLiveRegion="polite" style={styles.stateText}>
            {t('personalCardPhoto.loadError')}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setDecodeFailureUrl(null);
              retry();
            }}
            style={({ pressed }) => [styles.retry, pressed ? styles.pressed : null]}
          >
            <Text style={styles.retryLabel}>{t('common.retry')}</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  image: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: radius.sm,
    backgroundColor: colors.paperStrong,
  },
  state: {
    minHeight: 124,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.paperStrong,
  },
  stateText: {
    color: colors.mutedInk,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  retry: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  retryLabel: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.68,
  },
});
