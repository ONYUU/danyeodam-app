import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { ApiResponseError } from './client';
import { createCurrentPoliciesService } from './policies';
import { createPublicPolicyApiClient } from './public-policy-transport';

const authInitialization = vi.hoisted(() => ({
  session: vi.fn(),
  supabase: vi.fn(),
}));

vi.mock('@/auth/session', () => {
  authInitialization.session();
  return { removeLocalSession: vi.fn() };
});
vi.mock('@/auth/supabase', () => {
  authInitialization.supabase();
  return { supabase: {} };
});

describe('public current-policy transport', () => {
  it('sends zero Authorization headers and cannot clear a session on public 401', async () => {
    const requestFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      return Response.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
    });
    const service = createCurrentPoliciesService(createPublicPolicyApiClient({
      apiBaseUrl: 'https://api.danyeodam.invalid',
      fetch: requestFetch,
    }));

    const error = await service.current().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiResponseError);
    expect(error).toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
    expect(requestFetch).toHaveBeenCalledOnce();
    expect(authInitialization.session).not.toHaveBeenCalled();
    expect(authInitialization.supabase).not.toHaveBeenCalled();

    const transport = readFileSync(
      new URL('./public-policy-transport.ts', import.meta.url),
      'utf8',
    );
    expect(transport).toContain('return null;');
    expect(transport).toContain('async clearLocalSession()');
    expect(transport).not.toMatch(/from ['"]@\/auth\//u);
    expect(transport).not.toMatch(/from ['"]\.\/index['"]/u);
  });
});
