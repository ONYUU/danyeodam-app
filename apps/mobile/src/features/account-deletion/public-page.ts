export function resolvePublicAccountDeletionUrl(apiBaseUrl: string): string {
  let base: URL;
  try {
    base = new URL(apiBaseUrl);
  } catch {
    throw new Error('ACCOUNT_DELETION_PUBLIC_URL_INVALID');
  }
  const loopback = base.hostname === 'localhost' || base.hostname === '127.0.0.1';
  if (
    (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback))
    || base.username !== ''
    || base.password !== ''
  ) {
    throw new Error('ACCOUNT_DELETION_PUBLIC_URL_INVALID');
  }
  return new URL('/account/delete', base.origin).toString();
}
