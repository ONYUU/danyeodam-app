import { PrivacyRightsSessionProvider } from '@/auth/privacy-rights-session-provider';
import { PrivacyRightsEntry } from '@/features/privacy-rights/privacy-rights-entry';

type PrivacyRightsApplicationProps = {
  onExit(): void;
};

export default function PrivacyRightsApplication({
  onExit,
}: PrivacyRightsApplicationProps) {
  return (
    <PrivacyRightsSessionProvider>
      <PrivacyRightsEntry onExit={onExit} />
    </PrivacyRightsSessionProvider>
  );
}
