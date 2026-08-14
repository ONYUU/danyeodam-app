import {
  PolicyResourceVerificationError,
  type VerifiedTrustedResource,
} from './verification';

export type VerifiedRenderableResource = {
  contentType: string;
  text: string;
  url: string;
};

function decodeEntity(entity: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  const body = entity.slice(1, -1);
  const namedValue = named[body.toLowerCase()];
  if (namedValue !== undefined) return namedValue;
  const hexadecimal = /^#x([0-9a-f]+)$/iu.exec(body);
  const decimal = /^#(\d+)$/u.exec(body);
  const codePoint = hexadecimal !== null
    ? Number.parseInt(hexadecimal[1]!, 16)
    : decimal !== null
      ? Number.parseInt(decimal[1]!, 10)
      : null;
  if (
    codePoint === null
    || !Number.isInteger(codePoint)
    || codePoint < 0
    || codePoint > 0x10ffff
    || (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return entity;
  }
  return String.fromCodePoint(codePoint);
}

function htmlToReadableText(html: string): string {
  return html
    .replace(/<(?:script|style|template|noscript|svg)\b[^>]*>[\s\S]*?<\/(?:script|style|template|noscript|svg)\s*>/giu, '\n')
    .replace(/<li\b[^>]*>/giu, '\n• ')
    .replace(/<(?:br|hr)\b[^>]*\/?\s*>/giu, '\n')
    .replace(/<\/?(?:address|article|aside|blockquote|div|footer|h[1-6]|header|main|nav|ol|p|pre|section|table|tr|ul)\b[^>]*>/giu, '\n')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/giu, decodeEntity)
    .replace(/[ \t]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

export function renderVerifiedTextResource(
  resource: VerifiedTrustedResource,
): VerifiedRenderableResource {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(resource.bytes);
  } catch {
    throw new PolicyResourceVerificationError();
  }
  if (/\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(decoded)) {
    throw new PolicyResourceVerificationError();
  }
  const text = resource.contentType === 'text/plain'
    ? decoded.replace(/\r\n?/gu, '\n').trim()
    : htmlToReadableText(decoded);
  if (text.length === 0) {
    throw new PolicyResourceVerificationError();
  }
  return {
    contentType: resource.contentType,
    text,
    url: resource.url,
  };
}
