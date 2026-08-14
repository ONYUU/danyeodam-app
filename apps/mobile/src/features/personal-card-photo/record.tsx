import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { CollectionItem } from '@/api/collection';
import { useSessionDataRefresh } from '@/features/session-data/refresh-provider';
import { useI18n } from '@/i18n/locale-provider';
import { colors, spacing } from '@/theme/tokens';

import { PersonalCardPhotoDeletePanel } from './delete-panel';
import { PersonalCardPhotoView } from './photo-view';

type PersonalCard = NonNullable<CollectionItem['personalCard']>;

export function PersonalCardPhotoRecord(input: {
  personalCard: PersonalCard;
}) {
  const { t } = useI18n();
  const { refreshCollection } = useSessionDataRefresh();
  const [hiddenAfterAcceptedDelete, setHiddenAfterAcceptedDelete] = useState(false);

  if (hiddenAfterAcceptedDelete) {
    return (
      <Text accessibilityLiveRegion="polite" style={styles.accepted}>
        {t('personalCardPhoto.removeAccepted')}
      </Text>
    );
  }

  return (
    <View style={styles.personalCard}>
      <PersonalCardPhotoView
        personalCardId={input.personalCard.id}
        photoPath={input.personalCard.photoPath}
      />
      {input.personalCard.caption.length === 0 ? null : (
        <Text numberOfLines={3} style={styles.caption}>
          “{input.personalCard.caption}”
        </Text>
      )}
      <PersonalCardPhotoDeletePanel
        personalCardId={input.personalCard.id}
        onAccepted={() => {
          // Removing the view releases the object URL/native Blob in its hook
          // cleanup before any eventual deletion worker completes.
          setHiddenAfterAcceptedDelete(true);
          refreshCollection();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  personalCard: {
    gap: spacing.sm,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  caption: {
    color: colors.ink,
    fontSize: 13,
    fontStyle: 'italic',
    lineHeight: 19,
  },
  accepted: {
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    color: colors.accent,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 18,
  },
});
