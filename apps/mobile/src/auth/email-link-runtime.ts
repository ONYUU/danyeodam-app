import { apiClient } from '@/api';
import { getRuntimeEnvironment } from '@/config/runtime-environment';

import { completeAuthCallback, parseRejectedAuthCallbackFlowId } from './callback';
import { completeEmailLinkWithActiveIdentity } from './email-link-completion';
import { createEmailLinkCodeExchange } from './email-link-exchange';
import { createNativeEmailLinkPkce } from './email-link-pkce-native';
import { pendingEmailLinkStore } from './email-link-storage';
import { startEmailLink } from './email-link';
import { removeLocalSession } from './session';
import { supabase } from './supabase';

const environment = getRuntimeEnvironment();
const exchangeCode = createEmailLinkCodeExchange({
  supabaseUrl: environment.supabaseUrl,
  publishableKey: environment.supabasePublishableKey,
});

export function requestEmailLink(email: string): Promise<void> {
  return startEmailLink(email, {
    auth: supabase.auth,
    api: apiClient,
    pending: pendingEmailLinkStore,
    createPkce: createNativeEmailLinkPkce,
  });
}

export function completeEmailLinkCallback(url: string): Promise<void> {
  return completeEmailLinkWithActiveIdentity(url, {
    complete: (callbackUrl) => completeAuthCallback(callbackUrl, {
      consumePending: (flowId) => pendingEmailLinkStore.consume(flowId),
      exchangeCode,
      setSession: (tokens) => supabase.auth.setSession(tokens),
      clearSession: () => removeLocalSession(supabase.auth),
    }),
    verifyActiveIdentity: () => apiClient('/api/me/access', { authenticated: true }),
    rejectedFlowId: parseRejectedAuthCallbackFlowId,
    clearRejectedFlow: (flowId) => pendingEmailLinkStore.clear(flowId),
  });
}
