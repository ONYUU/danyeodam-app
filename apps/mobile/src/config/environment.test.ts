import { describe, expect, it } from 'vitest';

import {
  parseApiBaseUrl,
  parseAppEnvironment,
  parsePolicyAllowedOrigins,
  parseSupabasePublishableKey,
  parseSupabaseUrl,
  resolvePublicEnvironment,
} from './environment';

describe('public environment validation', () => {
  it('uses safe local defaults only in development', () => {
    expect(resolvePublicEnvironment({})).toEqual({
      appEnvironment: 'development',
      apiBaseUrl: 'http://127.0.0.1:3000',
      supabaseUrl: 'http://127.0.0.1:54321',
      supabasePublishableKey: 'local-development-publishable-key',
      policyAllowedOrigins: [],
    });
  });

  it('requires a configured endpoint for production', () => {
    expect(() => resolvePublicEnvironment({ APP_ENV: 'production' })).toThrow(
      'EXPO_PUBLIC_API_BASE_URL is required',
    );
  });

  it('requires https for preview and production', () => {
    expect(() => parseApiBaseUrl('http://api.release-fixture.danyeodam.app', 'preview')).toThrow(
      'must use https',
    );
    expect(parseApiBaseUrl(
      'https://api.release-fixture.danyeodam.app/',
      'production',
    )).toBe(
      'https://api.release-fixture.danyeodam.app',
    );
  });

  it('rejects unsupported environments and credential-bearing URLs', () => {
    expect(() => parseAppEnvironment('staging')).toThrow('APP_ENV must be one of');
    expect(() =>
      parseApiBaseUrl(
        'https://user:password@api.release-fixture.danyeodam.app',
        'production',
      ),
    ).toThrow('must not contain credentials');
  });

  it.each([
    'https://localhost',
    'https://service.local',
    'https://127.0.0.1',
    'https://10.0.0.1',
    'https://172.16.0.1',
    'https://192.168.1.2',
    'https://169.254.10.2',
    'https://[::1]',
    'https://[fd00::1]',
    'https://[::ffff:127.0.0.1]',
    'https://api.invalid',
    'https://api.example',
    'https://api.test',
    'https://api.localhost',
    'https://local',
    'https://internal-api',
    'https://example.com',
    'https://subdomain.example.net',
    'https://example.org',
    'https://192.0.2.10',
    'https://192.0.0.1',
    'https://192.88.99.1',
    'https://198.51.100.10',
    'https://203.0.113.10',
    'https://[2001:db8::10]',
    'https://[100::1]',
    'https://[100:0:0:1::1]',
    'https://[2001:5::1]',
    'https://[300::1]',
    'https://[3fff::10]',
    'https://[::192.0.2.10]',
    'https://[::8.8.8.8]',
    'https://[::ffff:8.8.8.8]',
    'https://[64:ff9b::c000:201]',
    'https://[ff02::1]',
    'https://device.home.arpa',
    'https://service.internal',
    'https://service.onion',
  ])('rejects non-public production endpoint %s', (endpoint) => {
    expect(() => parseApiBaseUrl(endpoint, 'production')).toThrow(
      'must not use private, reserved, documentation, or placeholder hosts',
    );
  });

  it.each([
    'https://api.release-fixture.danyeodam.app?token=public',
    'https://api.release-fixture.danyeodam.app/#fragment',
  ])('rejects a production query or fragment in %s', (endpoint) => {
    expect(() => parseApiBaseUrl(endpoint, 'production')).toThrow(
      'must not include a query or fragment',
    );
  });

  it('keeps the explicit development-only local exception', () => {
    expect(parseApiBaseUrl('http://10.0.2.2:3000', 'e2e')).toBe(
      'http://10.0.2.2:3000',
    );
  });

  it('requires a public HTTPS Supabase endpoint for public builds', () => {
    expect(parseSupabaseUrl('https://project.supabase.co/', 'production')).toBe(
      'https://project.supabase.co',
    );
    expect(() => parseSupabaseUrl('http://project.supabase.co', 'production')).toThrow(
      'must use https',
    );
    expect(() => parseSupabaseUrl('https://127.0.0.1', 'production')).toThrow(
      'must not use private, reserved, documentation, or placeholder hosts',
    );
    expect(() => parseSupabaseUrl('https://project.supabase.co/rest', 'production')).toThrow(
      'must not contain a path',
    );
  });

  it('accepts only publishable or legacy anon keys in public builds', () => {
    expect(parseSupabasePublishableKey(
      'sb_publishable_1234567890abcdef',
      'production',
    )).toBe('sb_publishable_1234567890abcdef');
    const anonPayload = Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url');
    const servicePayload = Buffer.from(JSON.stringify({ role: 'service_role' })).toString(
      'base64url',
    );
    expect(parseSupabasePublishableKey(`x.${anonPayload}.x`, 'production')).toBe(
      `x.${anonPayload}.x`,
    );
    expect(() => parseSupabasePublishableKey(
      `x.${servicePayload}.x`,
      'production',
    )).toThrow('publishable key or legacy anon key');
    expect(() => parseSupabasePublishableKey(
      'sb_secret_never_bundle_this',
      'production',
    )).toThrow('must never be bundled');
    expect(() => parseSupabasePublishableKey(
      'sb_publishable_replace_with_real_value',
      'production',
    )).toThrow('must not be a placeholder value');
    expect(() => parseSupabasePublishableKey(
      'sb_publishable_!!!!!!!!!!!!',
      'production',
    )).toThrow('must be a publishable key');
  });

  it('requires an exact public HTTPS policy-origin allowlist for public builds', () => {
    expect(parsePolicyAllowedOrigins(
      'https://policies.release-fixture.danyeodam.app, https://support.release-fixture.danyeodam.app/',
      'production',
    )).toEqual([
      'https://policies.release-fixture.danyeodam.app',
      'https://support.release-fixture.danyeodam.app',
    ]);
    expect(() => parsePolicyAllowedOrigins('', 'production')).toThrow(
      'is required',
    );
    for (const value of [
      'http://policies.release-fixture.danyeodam.app',
      'https://policies.release-fixture.danyeodam.app/path',
      'https://127.0.0.1',
      'https://192.0.2.20',
      'https://[2001:db8::20]',
      'https://policies.invalid',
      'https://example.com',
      'https://user:password@policies.release-fixture.danyeodam.app',
      'https://policies.release-fixture.danyeodam.app,https://policies.release-fixture.danyeodam.app/',
    ]) {
      expect(() => parsePolicyAllowedOrigins(value, 'production')).toThrow();
    }
  });
});
