import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function resolveRuntimeImport(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return null;
  const base = specifier.startsWith('@/')
    ? resolve(process.cwd(), 'src', specifier.slice(2))
    : resolve(dirname(importer), specifier);
  const candidates = extname(base) === '' ? [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.cjs`,
    resolve(base, 'index.ts'),
    resolve(base, 'index.tsx'),
  ] : [base];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function eagerRuntimeGraph(entry: string): ReadonlySet<string> {
  const pending = [resolve(process.cwd(), entry)];
  const visited = new Set<string>();
  // Type-only and dynamic imports are intentionally excluded: neither eagerly
  // initializes a runtime module when the pre-age root/hub bundle is loaded.
  const importPattern = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gmu;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const contents = readFileSync(current, 'utf8');
    for (const match of contents.matchAll(importPattern)) {
      const dependency = resolveRuntimeImport(current, match[1]!);
      if (dependency !== null && !visited.has(dependency)) pending.push(dependency);
    }
  }
  return visited;
}

describe('always-available policy and support boundary', () => {
  it('sits outside account, age, reviewer, and anonymous session gates', () => {
    const layout = source('src/app/_layout.tsx');
    expect(layout.indexOf('<PolicySupportBoundary>')).toBeLessThan(
      layout.indexOf('<AccountDeletionProvider>'),
    );
    expect(source('src/features/minimum-age/minimum-age-screen.tsx'))
      .toContain('policySupport.openHub');
  });

  it('keeps privacy policy one action from Settings and the full hub beside it', () => {
    const settings = source('src/app/(tabs)/settings.tsx');
    expect(settings).toContain('onPress={policySupport.openPrivacyPolicy}');
    expect(settings).toContain('accessibilityRole="link"');
    expect(settings).toContain('onPress={policySupport.openHub}');
  });

  it('locks Apple and Google accessibility into anonymous and reviewer surfaces', () => {
    expect(source('src/features/minimum-age/minimum-age-screen.tsx'))
      .toContain('policySupport.openHub');
    expect(source('src/app/reviewer-login.tsx'))
      .toContain('policySupport.openHub');
    const hub = source('src/features/policy-support/hub.tsx');
    expect(hub).toContain('type === request.focus');
    expect(source('src/features/policy-support/provider.tsx'))
      .toContain("openPrivacyPolicy: () => open('privacy_policy')");
    expect(hub).toContain('verifyPolicyDocument');
  });

  it('uses the public current-policy endpoint without an auth token', () => {
    const policies = source('src/api/policies.ts');
    expect(policies).toContain("client<unknown>('/api/policies/current'");
    expect(policies).toContain('authenticated: false');
  });

  it('keeps the complete pre-age policy bundle graph outside auth initialization', () => {
    const rootGraph = eagerRuntimeGraph('src/app/_layout.tsx');
    const hubGraph = eagerRuntimeGraph('src/features/policy-support/hub.tsx');
    const combined = [...new Set([...rootGraph, ...hubGraph])];

    expect(combined.some((path) => path.endsWith('/policy-support/hub.tsx'))).toBe(true);
    expect(combined.some((path) => path.endsWith('/api/public-policies-client.ts')))
      .toBe(true);
    expect(combined.filter((path) => (
      path.endsWith('/auth/supabase.ts')
      || path.endsWith('/auth/session.ts')
      || path.endsWith('/api/index.ts')
      || path.endsWith('/api/policies-client.ts')
    ))).toEqual([]);
  });

  it('displays the verified response bytes in-app without a second URL request', () => {
    const hub = source('src/features/policy-support/hub.tsx');
    expect(hub).toContain('setViewer({');
    expect(hub).toContain('{viewer.text}');
    expect(hub).not.toContain('Linking.openURL');
  });

  it('keeps the underlying form state mounted while the full-screen hub is open', () => {
    const boundary = source('src/features/policy-support/boundary.tsx');
    expect(boundary).toContain('<Modal');
    expect(boundary).toContain('{children}');
    expect(boundary).not.toContain('if (policySupport.request === null) return children');
    expect(boundary.indexOf('{children}')).toBeLessThan(boundary.indexOf('<Modal'));
    expect(boundary).toContain('visible={policySupport.request !== null}');
    expect(boundary).toContain('pointerEvents={policySupport.request === null ?');
    expect(boundary).toContain("'no-hide-descendants'");
    expect(boundary).toContain('accessibilityElementsHidden={policySupport.request !== null}');
    expect(boundary).toContain('accessibilityViewIsModal');
  });
});
