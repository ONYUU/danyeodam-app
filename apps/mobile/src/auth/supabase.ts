import 'react-native-url-polyfill/auto';

import { createClient, processLock } from '@supabase/supabase-js';

import { getRuntimeEnvironment } from '../config/runtime-environment';
import { MOBILE_AUTH_FLOW_TYPE } from './auth-policy';
import { sessionStorage } from './session-storage';

const environment = getRuntimeEnvironment();

export const supabase = createClient(
  environment.supabaseUrl,
  environment.supabasePublishableKey,
  {
    auth: {
      flowType: MOBILE_AUTH_FLOW_TYPE,
      experimental: {
        appendPkceFlowIdToRedirects: true,
      },
      storage: sessionStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      lock: processLock,
    },
  },
);
