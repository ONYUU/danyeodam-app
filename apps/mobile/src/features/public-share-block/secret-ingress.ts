const SHARE_BLOCK_URL_PATTERN =
  /^danyeodam:\/\/share-block#([A-Za-z0-9]{22,128})$/u;
const SHARE_BLOCK_CANDIDATE_PATTERN =
  /^danyeodam:\/\/share-block(?:[/?#]|$)/iu;

export type ShareBlockIngress =
  | Readonly<{ status: 'ready'; shareSecret: string }>
  | Readonly<{ status: 'invalid' }>;

export function parseShareBlockIngress(url: string): ShareBlockIngress {
  const match = SHARE_BLOCK_URL_PATTERN.exec(url);
  return match?.[1] === undefined
    ? { status: 'invalid' }
    : { status: 'ready', shareSecret: match[1] };
}

export function isShareBlockIngressCandidate(url: string): boolean {
  return SHARE_BLOCK_CANDIDATE_PATTERN.test(url);
}

export function sanitizedShareBlockRouteFor(pathname: string):
  | '/public-share-block'
  | '/share-block' {
  return pathname === '/public-share-block'
    ? '/share-block'
    : '/public-share-block';
}

export function createShareBlockIngressVault() {
  let pending: ShareBlockIngress | null = null;
  const invalid: ShareBlockIngress = Object.freeze({ status: 'invalid' });

  return {
    stage(url: string): void {
      pending = parseShareBlockIngress(url);
    },
    peek(): ShareBlockIngress {
      return pending ?? invalid;
    },
    acknowledge(value: ShareBlockIngress): void {
      if (pending === value) pending = null;
    },
  };
}

const ingressVault = createShareBlockIngressVault();

export const stageShareBlockIngress = ingressVault.stage;
export const peekShareBlockIngress = ingressVault.peek;
export const acknowledgeShareBlockIngress = ingressVault.acknowledge;
