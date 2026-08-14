import type {
  AccountDeletionAccepted,
  AccountDeletionCredential,
  AccountDeletionStatus,
} from '@/api/account-deletion';
import { ApiResponseError, ApiTransportError } from '@/api/client';

export type AccountDeletionLifecycleDependencies = {
  getStatus(credential: AccountDeletionCredential): Promise<AccountDeletionStatus>;
  request(credential: AccountDeletionCredential): Promise<AccountDeletionAccepted>;
  removeLocalSession(): Promise<void>;
};

export type AccountDeletionLifecycleResult =
  | { status: 'authorization_required' }
  | { status: 'pending'; reasonCode: 'retrying' | null; completeBy: string; supportUrl: string | null }
  | { status: 'action_required'; reasonCode: 'manual_support_required'; completeBy: string; supportUrl: string }
  | { status: 'completed'; completedAt: string; supportUrl: string | null };

function isNotFound(error: unknown): boolean {
  return error instanceof ApiResponseError
    && error.status === 404
    && error.code === 'NOT_FOUND';
}

function isDefinitiveAuthorizationFailure(error: unknown): boolean {
  return (
    error instanceof ApiResponseError
    && error.status === 401
    && error.code === 'UNAUTHORIZED'
  ) || (
    error instanceof ApiTransportError
    && error.failure === 'AUTH_SESSION_UNAVAILABLE'
  );
}

function project(status: AccountDeletionStatus): AccountDeletionLifecycleResult {
  if (status.status === 'completed') {
    return {
      status: 'completed',
      completedAt: status.completedAt!,
      supportUrl: status.supportUrl,
    };
  }
  if (status.status === 'action_required') {
    if (status.supportUrl === null) throw new Error('ACCOUNT_DELETION_SUPPORT_UNAVAILABLE');
    return {
      status: 'action_required',
      reasonCode: 'manual_support_required',
      completeBy: status.completeBy,
      supportUrl: status.supportUrl,
    };
  }
  return {
    status: 'pending',
    reasonCode: status.reasonCode === 'retrying' ? 'retrying' : null,
    completeBy: status.completeBy,
    supportUrl: status.supportUrl,
  };
}

async function readStatus(
  credential: AccountDeletionCredential,
  dependencies: AccountDeletionLifecycleDependencies,
): Promise<AccountDeletionLifecycleResult> {
  const status = await dependencies.getStatus(credential);
  await dependencies.removeLocalSession();
  return project(status);
}

export async function reconcileAccountDeletion(
  credential: AccountDeletionCredential,
  dependencies: AccountDeletionLifecycleDependencies,
): Promise<AccountDeletionLifecycleResult> {
  try {
    return await readStatus(credential, dependencies);
  } catch (firstError) {
    if (!isNotFound(firstError)) throw firstError;
  }

  try {
    const accepted = await dependencies.request(credential);
    await dependencies.removeLocalSession();
    return {
      status: 'pending',
      reasonCode: null,
      completeBy: accepted.completeBy,
      supportUrl: null,
    };
  } catch (requestError) {
    // The request may have committed before its response was lost or before
    // the old JWT was invalidated. Resolve only through the public status
    // credential; never generate a replacement account or request/token pair.
    try {
      return await readStatus(credential, dependencies);
    } catch (statusError) {
      // A public 404 both before and after a request that could not possibly
      // authenticate proves that this exact credential never started a
      // deletion. Surface an explicit restart path instead of trapping the
      // device behind a credential that can no longer authenticate.
      if (
        isDefinitiveAuthorizationFailure(requestError)
        && isNotFound(statusError)
      ) {
        return { status: 'authorization_required' };
      }
      throw requestError;
    }
  }
}
