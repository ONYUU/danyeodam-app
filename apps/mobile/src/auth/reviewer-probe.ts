import { createClient } from '@supabase/supabase-js';

import { getRuntimeEnvironment } from '@/config/runtime-environment';

import { MOBILE_AUTH_FLOW_TYPE } from './auth-policy';

export function createReviewerProbeAuth() {
  const environment = getRuntimeEnvironment();
  return createClient(
    environment.supabaseUrl,
    environment.supabasePublishableKey,
    {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        flowType: MOBILE_AUTH_FLOW_TYPE,
        persistSession: false,
      },
    },
  ).auth;
}
