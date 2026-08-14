const credentialKey = "danyeodam.account-deletion.v1";

export type DeletionCredential = {
  requestId: string;
  statusToken: string;
};

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;

export function createDeletionCredential(cryptoApi: Crypto): DeletionCredential {
  const bytes = new Uint8Array(32);
  cryptoApi.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return {
    requestId: cryptoApi.randomUUID(),
    statusToken: btoa(binary)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, ""),
  };
}

export function parseDeletionCredential(value: string | null): DeletionCredential | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const requestId = Reflect.get(parsed, "requestId");
    const statusToken = Reflect.get(parsed, "statusToken");
    if (
      typeof requestId !== "string"
      || !uuidV4Pattern.test(requestId)
      || typeof statusToken !== "string"
      || !tokenPattern.test(statusToken)
      || Object.keys(parsed).length !== 2
    ) return null;
    return { requestId, statusToken };
  } catch {
    return null;
  }
}

export function readDeletionCredential(storage: Storage): DeletionCredential | null {
  return parseDeletionCredential(storage.getItem(credentialKey));
}

export function storeDeletionCredential(
  storage: Storage,
  credential: DeletionCredential,
): void {
  storage.setItem(credentialKey, JSON.stringify(credential));
}

export function clearDeletionCredential(storage: Storage): void {
  storage.removeItem(credentialKey);
}
