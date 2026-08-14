import { describe, expect, it } from 'vitest';

import {
  createShareBlockIngressVault,
  isShareBlockIngressCandidate,
  parseShareBlockIngress,
  sanitizedShareBlockRouteFor,
} from './secret-ingress';

const secret = 'AbCdEfGhIjKlMnOpQrStUv';

describe('public-share block secret ingress', () => {
  it('accepts only the exact custom-scheme fragment form', () => {
    expect(parseShareBlockIngress(`danyeodam://share-block#${secret}`)).toEqual({
      status: 'ready',
      shareSecret: secret,
    });

    for (const url of [
      `https://danyeodam.example/share-block#${secret}`,
      `danyeodam://share-block?share_secret=${secret}`,
      `danyeodam://share-block/${secret}`,
      `danyeodam://share-block#${secret}%20`,
      `danyeodam://share-block#${secret}/extra`,
      'danyeodam://share-block',
    ]) {
      expect(parseShareBlockIngress(url)).toEqual({ status: 'invalid' });
    }
  });

  it('keeps render reads pure and clears only the committed value', () => {
    const vault = createShareBlockIngressVault();
    vault.stage(`danyeodam://share-block#${secret}`);
    const firstRender = vault.peek();
    expect(firstRender).toEqual({ status: 'ready', shareSecret: secret });
    expect(vault.peek()).toBe(firstRender);
    vault.acknowledge(firstRender);
    expect(vault.peek()).toEqual({ status: 'invalid' });
  });

  it('does not let an abandoned render or stale commit consume a newer link', () => {
    const vault = createShareBlockIngressVault();
    vault.stage(`danyeodam://share-block#${secret}`);
    const abandoned = vault.peek();
    const newerSecret = 'B'.repeat(24);
    vault.stage(`danyeodam://share-block#${newerSecret}`);
    vault.acknowledge(abandoned);
    const committed = vault.peek();
    expect(committed).toEqual({ status: 'ready', shareSecret: newerSecret });
    vault.acknowledge(committed);
    expect(vault.peek()).toEqual({ status: 'invalid' });
  });

  it('intercepts malformed share-block targets but ignores unrelated links', () => {
    expect(isShareBlockIngressCandidate(`danyeodam://share-block#${secret}`)).toBe(true);
    expect(isShareBlockIngressCandidate(`danyeodam://share-block?secret=${secret}`)).toBe(true);
    expect(isShareBlockIngressCandidate('DANYEODAM://SHARE-BLOCK')).toBe(true);
    expect(isShareBlockIngressCandidate('danyeodam://share-blocker#bad')).toBe(false);
    expect(isShareBlockIngressCandidate('danyeodam://auth/callback?code=x')).toBe(false);
  });

  it('bounces a new warm link through a secret-free route to remount its screen', () => {
    // A live link while the public screen is mounted first bounces through the
    // secret-free ingress route; that route replaces back to the public screen.
    expect(sanitizedShareBlockRouteFor('/public-share-block')).toBe('/share-block');
    // Cold ingress and live ingress from any other route go straight to the
    // secret-free public screen after staging the fragment in the one-use vault.
    expect(sanitizedShareBlockRouteFor('/(tabs)/settings')).toBe('/public-share-block');
  });
});
