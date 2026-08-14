import { describe, expect, it } from 'vitest';

import {
  evaluateBirthDate,
  getKoreaCalendarDate,
  type CalendarDate,
} from './policy';

const today: CalendarDate = { year: 2026, month: 8, day: 12 };

describe('minimum-age calendar policy', () => {
  it('uses a completed calendar anniversary without millisecond age math', () => {
    expect(evaluateBirthDate({ year: '2008', month: '8', day: '12' }, today))
      .toBe('eligible');
    expect(evaluateBirthDate({ year: '2008', month: '8', day: '13' }, today))
      .toBe('ineligible');
    expect(evaluateBirthDate({ year: '2007', month: '12', day: '31' }, today))
      .toBe('eligible');
  });

  it('rejects invalid, future, and incomplete calendar input', () => {
    expect(evaluateBirthDate({ year: '2007', month: '2', day: '29' }, today))
      .toBe('invalid');
    expect(evaluateBirthDate({ year: '2027', month: '1', day: '1' }, today))
      .toBe('invalid');
    expect(evaluateBirthDate({ year: '08', month: '8', day: '12' }, today))
      .toBe('invalid');
  });

  it('handles leap-day input as a real Gregorian calendar date', () => {
    expect(evaluateBirthDate(
      { year: '2008', month: '2', day: '29' },
      { year: 2026, month: 2, day: 28 },
    )).toBe('ineligible');
    expect(evaluateBirthDate(
      { year: '2008', month: '2', day: '29' },
      { year: 2026, month: 3, day: 1 },
    )).toBe('eligible');
  });

  it('derives the service date from the instant rather than the device timezone', () => {
    expect(getKoreaCalendarDate(new Date('2026-08-11T14:59:59.999Z'))).toEqual({
      year: 2026,
      month: 8,
      day: 11,
    });
    expect(getKoreaCalendarDate(new Date('2026-08-11T15:00:00.000Z'))).toEqual({
      year: 2026,
      month: 8,
      day: 12,
    });
  });
});
