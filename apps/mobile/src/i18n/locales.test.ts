import { describe, expect, it } from 'vitest';

import { resolveSupportedLocale, SUPPORTED_LOCALES } from './locales';
import { TRANSLATIONS } from './translations';

const minimumAgeKeys = [
  'ageGate.title',
  'ageGate.body',
  'ageGate.privacy',
  'ageGate.year',
  'ageGate.month',
  'ageGate.day',
  'ageGate.continue',
  'ageGate.invalidDate',
  'ageGate.loadingTitle',
  'ageGate.loadingBody',
  'ageGate.savingTitle',
  'ageGate.savingBody',
  'ageGate.unavailableTitle',
  'ageGate.unavailableBody',
  'ageGate.storageErrorTitle',
  'ageGate.storageErrorBody',
  'ageGate.attestingTitle',
  'ageGate.attestingBody',
  'ageGate.attestationErrorTitle',
  'ageGate.attestationErrorBody',
  'ageGate.sessionErrorTitle',
  'ageGate.sessionErrorBody',
  'ageGate.privacyRightsAction',
  'ageGate.privacyRightsTitle',
  'ageGate.privacyRightsCheckingBody',
] as const;

const accountDeletionKeys = [
  'accountDeletion.requestTitle',
  'accountDeletion.requestBody',
  'accountDeletion.requestAction',
  'accountDeletion.confirmTitle',
  'accountDeletion.confirmBody',
  'accountDeletion.confirmAction',
  'accountDeletion.startError',
  'accountDeletion.checkingTitle',
  'accountDeletion.checkingBody',
  'accountDeletion.errorTitle',
  'accountDeletion.errorBody',
  'accountDeletion.pendingTitle',
  'accountDeletion.pendingBody',
  'accountDeletion.actionRequiredTitle',
  'accountDeletion.actionRequiredBody',
  'accountDeletion.openSupport',
  'accountDeletion.supportOpenError',
  'accountDeletion.completedTitle',
  'accountDeletion.completedBody',
  'accountDeletion.finish',
  'accountDeletion.localCleanupError',
  'accountDeletion.openPublicPage',
  'accountDeletion.publicPageError',
] as const;

const blockSafetyKeys = [
  'blocks.settingsTitle',
  'blocks.settingsBody',
  'blocks.openList',
  'blocks.listTitle',
  'blocks.listBody',
  'blocks.listError',
  'blocks.empty',
  'blocks.opaqueAccount',
  'blocks.blockedAt',
  'blocks.opaqueId',
  'blocks.unblock',
  'blocks.unblocking',
  'blocks.unblockError',
  'blocks.rateLimited',
  'blocks.retrySameAction',
  'blocks.loadMore',
  'blocks.loadMoreError',
  'shareBlock.checking',
  'shareBlock.title',
  'shareBlock.body',
  'shareBlock.confirm',
  'shareBlock.cancel',
  'shareBlock.working',
  'shareBlock.successTitle',
  'shareBlock.successBody',
  'shareBlock.invalidTitle',
  'shareBlock.invalidBody',
  'shareBlock.errorTitle',
  'shareBlock.errorBody',
  'shareBlock.rateLimited',
  'shareBlock.unavailable',
  'shareBlock.retrySameAction',
  'shareBlock.close',
] as const;

const personalCardPhotoKeys = [
  'personalCardPhoto.add',
  'personalCardPhoto.title',
  'personalCardPhoto.body',
  'personalCardPhoto.privacy',
  'personalCardPhoto.captionLabel',
  'personalCardPhoto.captionPlaceholder',
  'personalCardPhoto.choosing',
  'personalCardPhoto.preparing',
  'personalCardPhoto.uploading',
  'personalCardPhoto.creating',
  'personalCardPhoto.chooseAndSave',
  'personalCardPhoto.retrySame',
  'personalCardPhoto.cancel',
  'personalCardPhoto.stop',
  'personalCardPhoto.success',
  'personalCardPhoto.imageLabel',
  'personalCardPhoto.loading',
  'personalCardPhoto.loadError',
  'personalCardPhoto.accessRequired',
  'personalCardPhoto.error',
  'personalCardPhoto.expired',
  'personalCardPhoto.processing',
  'personalCardPhoto.quota',
  'personalCardPhoto.rateLimited',
  'personalCardPhoto.tooLarge',
  'personalCardPhoto.uncertain',
  'personalCardPhoto.unsupported',
  'personalCardPhoto.policyTitle',
  'personalCardPhoto.policyBody',
  'personalCardPhoto.policyLoading',
  'personalCardPhoto.policyLoadError',
  'personalCardPhoto.policyTerms',
  'personalCardPhoto.policyCommunity',
  'personalCardPhoto.policyVersion',
  'personalCardPhoto.policyHash',
  'personalCardPhoto.policyUrl',
  'personalCardPhoto.policyOpen',
  'personalCardPhoto.policyCheckbox',
  'personalCardPhoto.policyAccept',
  'personalCardPhoto.policyActionError',
  'personalCardPhoto.removeAction',
  'personalCardPhoto.removeTitle',
  'personalCardPhoto.removeBody',
  'personalCardPhoto.removeConfirm',
  'personalCardPhoto.removing',
  'personalCardPhoto.removeUncertain',
  'personalCardPhoto.removeError',
  'personalCardPhoto.removeRetry',
  'personalCardPhoto.removeAccepted',
] as const;

const bonusPackKeys = [
  'bonusPack.entryTitle',
  'bonusPack.entryBody',
  'bonusPack.entryUnopened',
  'bonusPack.entryNone',
  'bonusPack.openInbox',
  'bonusPack.rulesTitle',
  'bonusPack.odds',
  'bonusPack.guarantee',
  'bonusPack.oneDaily',
  'bonusPack.noExpiry',
  'bonusPack.noPurchase',
  'bonusPack.specialApproval',
  'bonusPack.listTitle',
  'bonusPack.listBody',
  'bonusPack.loading',
  'bonusPack.emptyTitle',
  'bonusPack.emptyBody',
  'bonusPack.sealed',
  'bonusPack.opened',
  'bonusPack.received',
  'bonusPack.view',
  'bonusPack.detailTitle',
  'bonusPack.sealedTitle',
  'bonusPack.sealedBody',
  'bonusPack.openAction',
  'bonusPack.opening',
  'bonusPack.openErrorTitle',
  'bonusPack.openErrorBody',
  'bonusPack.openedTitle',
  'bonusPack.resultAnnouncementCommon',
  'bonusPack.resultAnnouncementSpecial',
  'bonusPack.backToCards',
  'bonusPack.artPending',
  'bonusPack.rarityCommon',
  'bonusPack.raritySpecial',
  'inventory.title',
  'inventory.body',
  'inventory.empty',
  'inventory.loading',
  'inventory.open',
  'inventory.quantity',
  'collection.visitsTitle',
  'collection.visitsBody',
  'settings.hapticsTitle',
  'settings.hapticsBody',
  'settings.hapticsError',
  'acquire.bonusPackGrantedTitle',
  'acquire.bonusPackGrantedBody',
  'acquire.openBonusPack',
] as const;

describe('locale resolution', () => {
  it('matches exact and regional locales', () => {
    expect(resolveSupportedLocale(['ko-KR'])).toBe('ko');
    expect(resolveSupportedLocale(['ja-JP'])).toBe('ja');
    expect(resolveSupportedLocale(['vi-VN'])).toBe('vi');
  });

  it('keeps simplified and traditional Chinese separate', () => {
    expect(resolveSupportedLocale(['zh-CN'])).toBe('zh-Hans');
    expect(resolveSupportedLocale(['zh-Hant-TW'])).toBe('zh-Hant');
    expect(resolveSupportedLocale(['zh_HK'])).toBe('zh-Hant');
  });

  it('uses English when no preferred locale is supported', () => {
    expect(resolveSupportedLocale(['fr-FR', 'de-DE'])).toBe('en');
    expect(resolveSupportedLocale([])).toBe('en');
  });

  it('keeps the neutral minimum-age flow complete in every supported locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const values = minimumAgeKeys.map((key) => TRANSLATIONS[locale][key]);
      expect(values.every((value) => value.trim().length > 0)).toBe(true);
      expect(values.join(' ')).not.toMatch(
        /18|eighteen|adult|minimum age|성인|최소 연령|成年|成人|大人|trưởng thành|tuổi tối thiểu/iu,
      );
    }
  });

  it('keeps the destructive account-deletion flow complete in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const values = accountDeletionKeys.map((key) => TRANSLATIONS[locale][key]);
      expect(values.every((value) => value.trim().length > 0)).toBe(true);
      expect(TRANSLATIONS[locale]['accountDeletion.requestBody']).toMatch(/24/iu);
    }
  });

  it('keeps public-share block and opaque block management complete in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const values = blockSafetyKeys.map((key) => TRANSLATIONS[locale][key]);
      expect(values.every((value) => value.trim().length > 0)).toBe(true);
    }
  });

  it('keeps the private personal-card photo flow complete in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const values = personalCardPhotoKeys.map((key) => TRANSLATIONS[locale][key]);
      expect(values.every((value) => value.trim().length > 0)).toBe(true);
      expect(TRANSLATIONS[locale]['personalCardPhoto.privacy']).toMatch(/WebP/iu);
      expect(TRANSLATIONS[locale]['personalCardPhoto.privacy']).toMatch(/2048/iu);
      expect(TRANSLATIONS[locale]['personalCardPhoto.privacy']).toMatch(/EXIF/iu);
      expect(TRANSLATIONS[locale]['personalCardPhoto.privacy']).toMatch(/GPS/iu);
      expect(TRANSLATIONS[locale]['personalCardPhoto.policyHash']).toBe('SHA-256');
    }
  });

  it('keeps bonus packs, inventory, and reveal controls complete in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const values = bonusPackKeys.map((key) => TRANSLATIONS[locale][key]);
      expect(values.every((value) => value.trim().length > 0)).toBe(true);
      expect(TRANSLATIONS[locale]['bonusPack.odds']).toMatch(/80/u);
      expect(TRANSLATIONS[locale]['bonusPack.odds']).toMatch(/20/u);
      expect(TRANSLATIONS[locale]['bonusPack.guarantee']).toMatch(/4/u);
      expect(TRANSLATIONS[locale]['settings.hapticsBody']).toMatch(
        /sound|music|음악|효과음|音|音乐|音效|音樂|nhạc|âm thanh/iu,
      );
    }
  });
});
