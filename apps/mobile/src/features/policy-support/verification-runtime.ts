import { CryptoDigestAlgorithm, digest } from 'expo-crypto';
import { fetch as expoFetch } from 'expo/fetch';

import type { PolicyDocument, PolicyType } from '@/api/policies';

import {
  renderVerifiedTextResource,
  type VerifiedRenderableResource,
} from './rendering';
import { verifyTrustedResource } from './verification';

const TEXT_CONTENT_TYPES = [
  'text/html',
  'text/plain',
] as const;

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  return hex(await digest(CryptoDigestAlgorithm.SHA256, bytes));
}

export async function verifyPolicyDocument(input: {
  allowedOrigins: readonly string[];
  document: PolicyDocument;
  type: PolicyType;
  signal?: AbortSignal;
}): Promise<VerifiedRenderableResource> {
  const resource = await verifyTrustedResource({
    acceptedContentTypes: TEXT_CONTENT_TYPES,
    allowedOrigins: input.allowedOrigins,
    expectedSha256: input.document.sha256,
    fetchResource: expoFetch,
    hashBytes: sha256,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    url: input.document.url,
  });
  return renderVerifiedTextResource(resource);
}

export async function verifySupportUrl(input: {
  allowedOrigins: readonly string[];
  signal?: AbortSignal;
  url: string;
}): Promise<VerifiedRenderableResource> {
  const resource = await verifyTrustedResource({
    acceptedContentTypes: TEXT_CONTENT_TYPES,
    allowedOrigins: input.allowedOrigins,
    fetchResource: expoFetch,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    url: input.url,
  });
  return renderVerifiedTextResource(resource);
}
