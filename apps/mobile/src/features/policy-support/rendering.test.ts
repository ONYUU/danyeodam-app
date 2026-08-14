import { describe, expect, it } from 'vitest';

import { renderVerifiedTextResource } from './rendering';

function resource(text: string, contentType = 'text/html') {
  return {
    bytes: new TextEncoder().encode(text).buffer,
    contentType,
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

  it('rejects invalid UTF-8, control bytes, and empty display content', () => {
    expect(() => renderVerifiedTextResource({
      bytes: new Uint8Array([0xc3, 0x28]).buffer,
      contentType: 'text/plain',
      url: 'https://policies.example/privacy',
    })).toThrow('POLICY_RESOURCE_VERIFICATION_FAILED');
    expect(() => renderVerifiedTextResource(resource('safe\u0000unsafe', 'text/plain')))
      .toThrow('POLICY_RESOURCE_VERIFICATION_FAILED');
    expect(() => renderVerifiedTextResource(resource('<script>only script</script>')))
      .toThrow('POLICY_RESOURCE_VERIFICATION_FAILED');
  });
});
