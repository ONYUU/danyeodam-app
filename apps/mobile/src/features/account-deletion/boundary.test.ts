import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('mobile account deletion boundary', () => {
  it('places the deletion gate ahead of age, auth, and application trees', () => {
    const root = source('src/app/_layout.tsx');
    const provider = root.indexOf('<AccountDeletionProvider>');
    const gate = root.indexOf('<AccountDeletionGate>');
    const application = root.indexOf('<RootExperience />');
    expect(provider).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(provider);
    expect(application).toBeGreaterThan(gate);
  });

  it('persists the credential before starting a network lifecycle', () => {
    const provider = source('src/features/account-deletion/provider.tsx');
    const save = provider.indexOf('accountDeletionCredentialStore.save(credential)');
    const activate = provider.indexOf("phase: 'active'", save);
    expect(save).toBeGreaterThan(-1);
    expect(activate).toBeGreaterThan(save);
    expect(provider).not.toContain('signInAnonymously');
    expect(provider).not.toContain('restoreOrCreateAnonymousSession');
    expect(provider).not.toContain('console.');
  });

  it('removes local auth and age state before clearing the final credential', () => {
    const provider = source('src/features/account-deletion/provider.tsx');
    const removeSession = provider.indexOf('removeLocalSession(supabase.auth)');
    const clearEmail = provider.indexOf('pendingEmailLinkStore.clear()', removeSession);
    const clearAge = provider.indexOf('minimumAgeDevicePassStore.clear()', clearEmail);
    const clearCredential = provider.indexOf(
      'accountDeletionCredentialStore.clear(current.credential.requestId)',
      clearAge,
    );
    expect(removeSession).toBeGreaterThan(-1);
    expect(clearEmail).toBeGreaterThan(removeSession);
    expect(clearAge).toBeGreaterThan(clearEmail);
    expect(clearCredential).toBeGreaterThan(clearAge);
  });

  it('keeps the status credential off generic and authenticated requests', () => {
    const client = source('src/api/client.ts');
    const service = source('src/api/account-deletion.ts');
    expect(client).toContain('DELETION_STATUS_PATH_PATTERN');
    expect(client).toContain("method !== 'GET'");
    expect(client).toContain('authenticated');
    expect(service).toContain('authenticated: false');
    expect(service).toContain('deletionStatusToken: valid.statusToken');
    expect(service).not.toContain('console.');
  });

  it('keeps volatile Expo web deletion on the durable public flow', () => {
    const entry = source('src/features/privacy-rights/privacy-rights-entry.tsx');
    const webBoundary = entry.indexOf("Platform.OS === 'web'");
    const publicPage = entry.indexOf('resolvePublicAccountDeletionUrl(', webBoundary);
    const nativeBegin = entry.indexOf('accountDeletion.begin()', publicPage);
    expect(webBoundary).toBeGreaterThan(-1);
    expect(publicPage).toBeGreaterThan(webBoundary);
    expect(nativeBegin).toBeGreaterThan(publicPage);
  });

  it('has an explicit non-restoring exit for absent receipts without clearing ambiguity', () => {
    const lifecycle = source('src/features/account-deletion/lifecycle.ts');
    const provider = source('src/features/account-deletion/provider.tsx');
    expect(lifecycle).toContain("return { status: 'authorization_required' }");
    expect(lifecycle).toContain('isDefinitiveAuthorizationFailure(requestError)');
    expect(lifecycle).toContain('isNotFound(statusError)');
    expect(provider).toContain('restartAfterAuthorizationFailure');
    expect(provider).not.toContain('restoreOrCreateAnonymousSession');
  });
});
