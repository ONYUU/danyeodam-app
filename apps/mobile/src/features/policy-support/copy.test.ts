import { describe, expect, it } from 'vitest';

import { SUPPORTED_LOCALES, type SupportedLocale } from '@/i18n/locales';

import { policySupportCopy } from './copy';

const SUPPORT_HASH_BOUNDARY: Record<SupportedLocale, string> = {
  en: 'Support pages are not pinned by a content hash.',
  ja: 'サポートページはコンテンツハッシュ固定の対象ではありません。',
  ko: '고객지원 페이지는 콘텐츠 해시 고정 대상이 아닙니다.',
  vi: 'Trang hỗ trợ không được ghim vào một hàm băm nội dung cố định.',
  'zh-Hans': '客户支持页面不固定到特定内容哈希。',
  'zh-Hant': '客戶支援頁面不固定至特定內容雜湊。',
};

describe('policy and support translations', () => {
  it('keeps every label complete in all six locales', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const values = Object.values(policySupportCopy(locale));
      expect(values.every((value) => value.trim().length > 0)).toBe(true);
      expect(policySupportCopy(locale).overviewVerificationBody).toMatch(/SHA-256/iu);
      expect(policySupportCopy(locale).policyVerificationBody).toMatch(/SHA-256/iu);
      expect(policySupportCopy(locale).supportVerificationBody).not.toMatch(/SHA-256/iu);
      expect(policySupportCopy(locale).supportVerificationBody)
        .toContain(SUPPORT_HASH_BOUNDARY[locale]);
    }
  });
});
