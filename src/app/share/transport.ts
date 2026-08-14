export const PUBLIC_SHARE_ENDPOINTS = {
  ageAttestation: "/api/public-share/age-attestation",
  block: "/api/public-share/block",
  photo: "/api/public-share/photo",
  report: "/api/public-share/report",
  resolve: "/api/public-share/resolve",
} as const;

export const PUBLIC_SHARE_AGE_VERSION = "dob-18-v1";

export type PublicShareAgeCheck = "adult" | "underage" | "invalid";

const shareSecretPattern = /^[A-Za-z0-9]{22,128}$/u;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const supportedLocales = ["ko", "en", "ja", "zh-Hans", "zh-Hant", "vi"] as const;
const kstOffsetMilliseconds = 9 * 60 * 60 * 1_000;

export type ResolvedPublicShare = {
  dateKst: string;
  spotName: Record<(typeof supportedLocales)[number], string>;
  caption: string;
};

export type PublicShareReportReceipt = { id: string };

type FragmentSource = {
  location: { hash: string };
  history: { replaceState(data: unknown, unused: string, url?: string | URL | null): void };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function consumeShareSecretFromFragment(source: FragmentSource): string | null {
  const fragment = source.location.hash.startsWith("#")
    ? source.location.hash.slice(1)
    : "";
  source.history.replaceState(null, "", "/share");
  return shareSecretPattern.test(fragment) ? fragment : null;
}

export function classifyDateOfBirth(
  dateOfBirth: string,
  today = new Date(),
): PublicShareAgeCheck {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(dateOfBirth);
  if (match === null) return "invalid";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalized = new Date(Date.UTC(year, month - 1, day));
  if (
    normalized.getUTCFullYear() !== year
    || normalized.getUTCMonth() !== month - 1
    || normalized.getUTCDate() !== day
  ) {
    return "invalid";
  }
  const todayKst = new Date(today.getTime() + kstOffsetMilliseconds);
  const todayYear = todayKst.getUTCFullYear();
  const todayMonth = todayKst.getUTCMonth() + 1;
  const todayDay = todayKst.getUTCDate();
  if (
    year > todayYear
    || (year === todayYear && month > todayMonth)
    || (year === todayYear && month === todayMonth && day > todayDay)
  ) {
    return "invalid";
  }
  const eighteenthBirthdayHasPassed = month < todayMonth
    || (month === todayMonth && day <= todayDay);
  return year < todayYear - 18
    || (year === todayYear - 18 && eighteenthBirthdayHasPassed)
    ? "adult"
    : "underage";
}

export function publicShareSecretBody(shareSecret: string): string {
  return JSON.stringify({ share_secret: shareSecret });
}

export function publicShareBlockAppUrl(shareSecret: string): string | null {
  return shareSecretPattern.test(shareSecret)
    ? `danyeodam://share-block#${shareSecret}`
    : null;
}

export function publicShareReportBody(input: {
  shareSecret: string;
  clientReportId: string;
  reason: string;
  comment?: string;
}): string {
  return JSON.stringify({
    share_secret: input.shareSecret,
    client_report_id: input.clientReportId,
    target: "content",
    reason: input.reason,
    ...(input.comment === undefined ? {} : { comment: input.comment }),
  });
}

export function parseResolvedPublicShare(value: unknown): ResolvedPublicShare | null {
  if (!isRecord(value) || !hasExactlyKeys(value, [
    "date_kst", "spot", "caption", "photo_available",
  ])) return null;
  if (
    typeof value.date_kst !== "string"
    || !isoDatePattern.test(value.date_kst)
    || typeof value.caption !== "string"
    || value.caption.length > 60
    || value.photo_available !== true
    || !isRecord(value.spot)
    || !hasExactlyKeys(value.spot, ["name"])
    || !isRecord(value.spot.name)
    || !hasExactlyKeys(value.spot.name, supportedLocales)
  ) {
    return null;
  }
  const spotName = Object.fromEntries(supportedLocales.map((locale) => {
    const text = value.spot && isRecord(value.spot) && isRecord(value.spot.name)
      ? value.spot.name[locale]
      : undefined;
    return [locale, typeof text === "string" && text.length > 0 ? text : null];
  }));
  if (Object.values(spotName).some((text) => text === null)) return null;
  return {
    dateKst: value.date_kst,
    spotName: spotName as ResolvedPublicShare["spotName"],
    caption: value.caption,
  };
}

export function parsePublicShareReportReceipt(value: unknown): PublicShareReportReceipt | null {
  if (!isRecord(value) || !hasExactlyKeys(value, ["report"]) || !isRecord(value.report)) {
    return null;
  }
  if (
    !hasExactlyKeys(value.report, ["id", "status"])
    || typeof value.report.id !== "string"
    || !uuidPattern.test(value.report.id)
    || value.report.status !== "received"
  ) {
    return null;
  }
  return { id: value.report.id };
}

export function selectSpotName(
  names: ResolvedPublicShare["spotName"],
  locale: (typeof supportedLocales)[number],
): string {
  return names[locale];
}
