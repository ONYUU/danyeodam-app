import { describe, expect, it } from 'vitest';

import { ApiTransportError } from './client';
import {
  expectIsoDate,
  getLocalizedText,
  resolveApiAssetUrl,
} from './payload';

describe('read payload helpers', () => {
  it('uses the selected locale, then English, then Korean', () => {
    expect(getLocalizedText({ ja: '景福宮', en: 'Gyeongbokgung' }, 'ja', 'Unknown'))
      .toBe('景福宮');
    expect(getLocalizedText({ en: 'Gyeongbokgung' }, 'vi', 'Unknown'))
      .toBe('Gyeongbokgung');
    expect(getLocalizedText({ ko: '경복궁' }, 'vi', 'Unknown')).toBe('경복궁');
    expect(getLocalizedText({}, 'vi', 'Unknown')).toBe('Unknown');
  });

  it('rejects impossible calendar dates', () => {
    expect(() => expectIsoDate('2026-02-29')).toThrow(ApiTransportError);
    expect(expectIsoDate('2028-02-29')).toBe('2028-02-29');
  });

  it('keeps derived asset URLs on the configured API origin', () => {
    expect(resolveApiAssetUrl('https://api.example.com', '/api/card-assets/id'))
      .toBe('https://api.example.com/api/card-assets/id');
    expect(() => resolveApiAssetUrl('https://api.example.com', '//evil.example/image'))
      .toThrow(ApiTransportError);
  });
});
