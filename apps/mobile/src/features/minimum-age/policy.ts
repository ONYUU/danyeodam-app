export const MINIMUM_AGE_POLICY_VERSION = '18plus-v1' as const;

export type BirthDateFields = Readonly<{
  year: string;
  month: string;
  day: string;
}>;

export type CalendarDate = Readonly<{
  year: number;
  month: number;
  day: number;
}>;

export type MinimumAgeDecision = 'eligible' | 'ineligible' | 'invalid';

const MINIMUM_AGE_YEARS = 18;
const KOREA_STANDARD_TIME_OFFSET_MS = 9 * 60 * 60 * 1_000;
const FOUR_DIGITS = /^\d{4}$/u;
const ONE_OR_TWO_DIGITS = /^\d{1,2}$/u;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseBirthDate(fields: BirthDateFields): CalendarDate | null {
  if (
    !FOUR_DIGITS.test(fields.year)
    || !ONE_OR_TWO_DIGITS.test(fields.month)
    || !ONE_OR_TWO_DIGITS.test(fields.day)
  ) {
    return null;
  }

  const year = Number(fields.year);
  const month = Number(fields.month);
  const day = Number(fields.day);
  if (
    !Number.isInteger(year)
    || year < 1
    || month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
  ) {
    return null;
  }
  return { year, month, day };
}

function compareCalendarDates(left: CalendarDate, right: CalendarDate): number {
  if (left.year !== right.year) {
    return left.year - right.year;
  }
  if (left.month !== right.month) {
    return left.month - right.month;
  }
  return left.day - right.day;
}

export function getKoreaCalendarDate(now = new Date()): CalendarDate {
  const koreaTime = new Date(now.getTime() + KOREA_STANDARD_TIME_OFFSET_MS);
  return {
    year: koreaTime.getUTCFullYear(),
    month: koreaTime.getUTCMonth() + 1,
    day: koreaTime.getUTCDate(),
  };
}

export function evaluateBirthDate(
  fields: BirthDateFields,
  today = getKoreaCalendarDate(),
): MinimumAgeDecision {
  const birthDate = parseBirthDate(fields);
  if (birthDate === null || compareCalendarDates(birthDate, today) > 0) {
    return 'invalid';
  }

  const anniversary = {
    year: birthDate.year + MINIMUM_AGE_YEARS,
    month: birthDate.month,
    day: birthDate.day,
  };
  return compareCalendarDates(today, anniversary) >= 0
    ? 'eligible'
    : 'ineligible';
}
