import { classifyReadError } from '@/features/read/presentation';
import { useI18n } from '@/i18n/locale-provider';

import { ReadStatePanel } from './read-state-panel';

type ReadFailurePanelProps = {
  error: unknown;
  onRetry: () => void;
  onRestoreSession?: () => void;
};

export function ReadFailurePanel({
  error,
  onRetry,
  onRestoreSession,
}: ReadFailurePanelProps) {
  const { t } = useI18n();
  const kind = classifyReadError(error);
  if (kind === 'offline') {
    return (
      <ReadStatePanel
        actionLabel={t('common.retry')}
        body={t('common.offlineBody')}
        onAction={onRetry}
        title={t('common.offlineTitle')}
      />
    );
  }
  if (kind === 'session') {
    return (
      <ReadStatePanel
        actionLabel={t('common.restoreSession')}
        body={t('common.sessionBody')}
        onAction={onRestoreSession ?? onRetry}
        title={t('common.sessionTitle')}
      />
    );
  }
  return (
    <ReadStatePanel
      actionLabel={t('common.retry')}
      body={t('common.errorBody')}
      onAction={onRetry}
      title={t('common.errorTitle')}
    />
  );
}
