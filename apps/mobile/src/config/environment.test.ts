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
    expect(() => parseApiBaseUrl('http://example.com', 'preview')).toThrow(
      'must use https',
    );
    expect(parseApiBaseUrl('https://api.example.com/', 'production')).toBe(
      'https://api.example.com',
    );
  });

  it('rejects unsupported environments and credential-bearing URLs', () => {
    expect(() => parseAppEnvironment('staging')).toThrow('APP_ENV must be one of');
    expect(() =>
      parseApiBaseUrl('https://user:password@example.com', 'production'),
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
  ])('rejects private production endpoint %s', (endpoint) => {
    expect(() => parseApiBaseUrl(endpoint, 'production')).toThrow(
      'must not use localhost or a private network address',
    );
  });

  it.each([
    'https://api.example.com?token=public',
    'https://api.example.com/#fragment',
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
      'must not use localhost or a private network address',
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
  });

  it('requires an exact public HTTPS policy-origin allowlist for public builds', () => {
    expect(parsePolicyAllowedOrigins(
      'https://policies.example, https://support.example/',
      'production',
    )).toEqual(['https://policies.example', 'https://support.example']);
    expect(() => parsePolicyAllowedOrigins('', 'production')).toThrow(
      'is required',
    );
    for (const value of [
      'http://policies.example',
      'https://policies.example/path',
      'https://127.0.0.1',
      'https://user:password@policies.example',
      'https://policies.example,https://policies.example/',
    ]) {
      expect(() => parsePolicyAllowedOrigins(value, 'production')).toThrow();
    }
  });
});
