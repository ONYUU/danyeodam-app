import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('native public-share block boundary', () => {
  it('keeps the fragment out of navigation, storage, logs, and analytics', () => {
    const ingress = source('src/features/public-share-block/ingress-boundary.tsx');
    const route = source('src/app/share-block.tsx');
    const vault = source('src/features/public-share-block/secret-ingress.ts');
    expect(ingress).toContain('router.replace(sanitizedShareBlockRouteFor(');
    expect(ingress).toContain("pathnameRef.current === '/public-share-block'");
    expect(ingress).toContain('Linking.getInitialURL()');
    expect(ingress).toContain("Linking.addEventListener('url'");
    expect(ingress).not.toMatch(/params|query|SecureStore|localStorage|sessionStorage|console\.|analytics/iu);
    expect(route).not.toContain('stageInvalidShareBlockIngress');
    expect(route).toContain("router.replace('/public-share-block')");
    expect(vault).not.toMatch(/SecureStore|localStorage|sessionStorage|console\.|analytics/iu);
  });

  it('keeps ingress and block screens behind the authenticated adult stack', () => {
    const root = source('src/app/_layout.tsx');
    const application = source('src/app-root/authenticated-application.tsx');
    const ingressBoundary = root.indexOf('<PublicShareBlockIngressBoundary>');
    const deletionGate = root.indexOf('<AccountDeletionGate>');
    const rootExperience = root.indexOf('<RootExperience />');
    expect(ingressBoundary).toBeGreaterThan(-1);
    expect(deletionGate).toBeGreaterThan(ingressBoundary);
    expect(rootExperience).toBeGreaterThan(deletionGate);
    expect(root.indexOf('<MinimumAgeBoundary')).toBeGreaterThan(rootExperience);
    const attestation = application.indexOf('<MinimumAgeAttestationGate');
    for (const route of ['share-block', 'public-share-block', 'blocks']) {
      const routeIndex = application.indexOf(`<Stack.Screen name="${route}"`);
      expect(routeIndex).toBeGreaterThan(attestation);
    }
  });

  it('uses bearer API modules and never imports browser cookie helpers', () => {
    const screen = source('src/features/public-share-block/screen.tsx');
    const client = source('src/api/client.ts');
    expect(screen).toContain("from '@/api/blocks-client'");
    expect(screen).not.toMatch(/cookie|document\.|fetch\(/iu);
    expect(client).toContain("credentials: 'omit'");
  });
});
