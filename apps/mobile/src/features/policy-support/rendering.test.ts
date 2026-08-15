import { describe, expect, it } from 'vitest';

import { renderVerifiedTextResource } from './rendering';

function resource(text: string, contentType = 'text/html') {
  return {
    bytes: new TextEncoder().encode(text).buffer,
    contentType,
    integrity: 'sha256' as const,
    url: 'https://policies.example/privacy',
  };
}

describe('verified in-app policy rendering', () => {
  it('renders readable text only from the already verified response bytes', () => {
    expect(renderVerifiedTextResource(resource(`
      <h1>Privacy &amp; safety</h1>
      <script>throw new Error('must never execute')</script>
      <p>Body &#x2713;</p>
      <ul><li>One</li><li>Two</li></ul>
    `)).text).toBe('Privacy & safety\n\nBody ✓\n\n• One\n• Two');
  });

  it('preserves plain UTF-8 text and normalizes line endings', () => {
    expect(renderVerifiedTextResource(resource(
      '이용약관\r\n본문',
      'text/plain',
    )).text).toBe('이용약관\n본문');
  });

  it('uses HTML parsing semantics for malformed raw-text closing tags', () => {
    for (const html of [
      '<p>Before</p><script>alert(1)</script\t\n bar><p>After</p>',
      '<p>Before</p><SCRIPT data-value=">">alert(1)</SCRIPT foo=bar><p>After</p>',
      '<p title="1 > 0">Before</p><script>alert(1)</script><p>After</p>',
    ]) {
      expect(renderVerifiedTextResource(resource(html)).text).toBe('Before\n\nAfter');
    }
    expect(() => renderVerifiedTextResource(resource('<script>hidden without an end tag')))
      .toThrow('POLICY_RESOURCE_VERIFICATION_FAILED');
    expect(() => renderVerifiedTextResource(resource(
      '<script>hidden across a mismatched close</style><p>still hidden</p>',
    ))).toThrow('POLICY_RESOURCE_VERIFICATION_FAILED');
  });

  it('ignores comments, hidden subtrees, and attributes while decoding text entities once', () => {
    const hidden = [
      'iframe', 'noembed', 'noframes', 'noscript', 'object', 'script',
      'style', 'svg', 'template', 'textarea', 'title', 'xmp',
    ].map((tag) => `<${tag} data-value=">">hidden</${tag}>`).join('');
    expect(renderVerifiedTextResource(resource(`
      <!-- <p>comment text</p> --!>
      <p data-label="1 > 0">Before &amp; &#x1F642;</p>
      ${hidden}
      <p>&lt;script&gt; remains text</p>
    `)).text).toBe('Before & 🙂\n\n<script> remains text');
    expect(renderVerifiedTextResource(resource(
      '<!doctype html><html><head><title>hidden</title></head><body><p>Visible</p></body></html>',
    )).text).toBe('Visible');
    expect(renderVerifiedTextResource(resource('<p>&#0; &#x110000;</p>')).text)
      .toBe('� �');
  });

  it('suppresses plaintext and rejects controls introduced by character references', () => {
    expect(renderVerifiedTextResource(resource(
      '<p>Visible</p><plaintext>hidden</plaintext><p>also hidden</p>',
    )).text).toBe('Visible');
    expect(() => renderVerifiedTextResource(resource('<p>safe&#1;unsafe</p>')))
      .toThrow('POLICY_RESOURCE_VERIFICATION_FAILED');
    expect(renderVerifiedTextResource(resource('<p>first&#13;second</p>')).text)
      .toBe('first\nsecond');
  });

  it('rejects unsupported XHTML, oversized output, and costly HTML before parsing', () => {
    expect(() => renderVerifiedTextResource(resource(
      '<p>XML needs a dedicated parser</p>',
      'application/xhtml+xml',
    ))).toThrow('POLICY_RESOURCE_VERIFICATION_FAILED');
    expect(() => renderVerifiedTextResource(resource(
      'a'.repeat((256 * 1024) + 1),
      'text/plain',
    ))).toThrow('POLICY_RESOURCE_VERIFICATION_FAILED');
    expect(() => renderVerifiedTextResource(resource(
      `<p>${'a'.repeat(256 * 1024)}</p>`,
    ))).toThrow('POLICY_RESOURCE_VERIFICATION_FAILED');
    expect(() => renderVerifiedTextResource(resource(
      `${'<div>'.repeat(4_097)}safe`,
    ))).toThrow('POLICY_RESOURCE_VERIFICATION_FAILED');
  });

  it('rejects invalid UTF-8, control bytes, and empty display content', () => {
    expect(() => renderVerifiedTextResource({
      bytes: new Uint8Array([0xc3, 0x28]).buffer,
      contentType: 'text/plain',
      integrity: 'sha256',
      url: 'https://policies.example/privacy',
    })).toThrow('POLICY_RESOURCE_VERIFICATION_FAILED');
    expect(() => renderVerifiedTextResource(resource('safe\u0000unsafe', 'text/plain')))
      .toThrow('POLICY_RESOURCE_VERIFICATION_FAILED');
    expect(() => renderVerifiedTextResource(resource('<script>only script</script>')))
      .toThrow('POLICY_RESOURCE_VERIFICATION_FAILED');
  });
});
