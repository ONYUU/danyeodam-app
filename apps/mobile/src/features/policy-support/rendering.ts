import { parse, type DefaultTreeAdapterTypes } from 'parse5';

import {
  PolicyResourceVerificationError,
  type VerifiedTrustedResource,
} from './verification';

export type VerifiedRenderableResource = {
  contentType: string;
  integrity: VerifiedTrustedResource['integrity'];
  text: string;
  url: string;
};

const MAX_RENDERED_TEXT_CHARACTERS = 256 * 1024;
const MAX_HTML_BYTES = 256 * 1024;
const MAX_HTML_MARKUP_STARTS = 4_096;

const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'dd', 'details', 'dialog',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1',
  'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'main', 'menu', 'nav', 'ol',
  'p', 'pre', 'section', 'summary', 'table', 'tbody', 'tfoot', 'thead', 'tr', 'ul',
]);

const SUPPRESSED_ELEMENTS = new Set([
  'audio', 'base', 'canvas', 'embed', 'head', 'iframe', 'link', 'math', 'meta',
  'noembed', 'noframes', 'noscript', 'object', 'plaintext', 'script', 'source',
  'style', 'svg', 'template', 'textarea', 'title', 'track', 'video', 'xmp',
]);

type TraversalFrame = {
  node: DefaultTreeAdapterTypes.Node;
  phase: 'enter' | 'exit';
};

function append(parts: string[], state: { length: number }, value: string): void {
  if (value.length === 0) return;
  state.length += value.length;
  if (state.length > MAX_RENDERED_TEXT_CHARACTERS) {
    throw new PolicyResourceVerificationError();
  }
  parts.push(value);
}

function assertBoundedHtmlComplexity(html: string, byteLength: number): void {
  if (byteLength > MAX_HTML_BYTES) throw new PolicyResourceVerificationError();
  let markupStarts = 0;
  for (let index = 0; index < html.length; index += 1) {
    if (html.charCodeAt(index) !== 0x3c) continue;
    markupStarts += 1;
    if (markupStarts > MAX_HTML_MARKUP_STARTS) {
      throw new PolicyResourceVerificationError();
    }
  }
}

function htmlToReadableText(html: string, byteLength: number): string {
  assertBoundedHtmlComplexity(html, byteLength);
  const document = parse(html);
  const parts: string[] = [];
  const state = { length: 0 };
  const stack: TraversalFrame[] = [...document.childNodes]
    .reverse()
    .map((node) => ({ node, phase: 'enter' }));

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { node } = frame;
    if (frame.phase === 'exit') {
      append(parts, state, '\n');
      continue;
    }
    if (node.nodeName === '#text' && 'value' in node) {
      append(parts, state, node.value);
      continue;
    }
    if (!('tagName' in node)) continue;

    const tagName = node.tagName.toLowerCase();
    if (SUPPRESSED_ELEMENTS.has(tagName)) continue;
    if (tagName === 'br' || tagName === 'hr') {
      append(parts, state, '\n');
      continue;
    }
    if (tagName === 'li') {
      append(parts, state, '\n• ');
    } else if (tagName === 'td' || tagName === 'th' || tagName === 'wbr') {
      append(parts, state, ' ');
    } else if (BLOCK_ELEMENTS.has(tagName)) {
      append(parts, state, '\n');
      stack.push({ node, phase: 'exit' });
    }
    for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
      stack.push({ node: node.childNodes[index]!, phase: 'enter' });
    }
  }

  return parts.join('')
    .replace(/\r\n?/gu, '\n')
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
  let text: string;
  try {
    if (resource.contentType === 'text/plain') {
      text = decoded.replace(/\r\n?/gu, '\n').trim();
    } else if (resource.contentType === 'text/html') {
      text = htmlToReadableText(decoded, resource.bytes.byteLength);
    } else {
      throw new PolicyResourceVerificationError();
    }
  } catch {
    throw new PolicyResourceVerificationError();
  }
  if (
    text.length === 0
    || text.length > MAX_RENDERED_TEXT_CHARACTERS
    || /\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)
  ) {
    throw new PolicyResourceVerificationError();
  }
  return {
    contentType: resource.contentType,
    integrity: resource.integrity,
    text,
    url: resource.url,
  };
}
