import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getServerEnvironment } from "@/server/env";

let cachedServiceClient: SupabaseClient | undefined;
const serviceRequestTimeoutMs = 30_000;

function serviceFetch(operationSignal?: AbortSignal): typeof fetch {
  return (input, init) => {
    const signals = [
      operationSignal,
      init?.signal,
      AbortSignal.timeout(serviceRequestTimeoutMs),
    ].filter((signal): signal is AbortSignal => signal !== undefined);
    return fetch(input, {
      ...init,
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    });
  };
}

function createServiceClient(operationSignal?: AbortSignal): SupabaseClient {
  const environment = getServerEnvironment();
  return createClient(
    environment.NEXT_PUBLIC_SUPABASE_URL,
    environment.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
      global: {
        fetch: serviceFetch(operationSignal),
        headers: {
          "X-Client-Info": "danyeodam-server",
        },
      },
    },
  );
}

export function createSignalScopedServiceClient(signal: AbortSignal): SupabaseClient {
  return createServiceClient(signal);
}

export function getServiceClient(): SupabaseClient {
  if (cachedServiceClient !== undefined) {
    return cachedServiceClient;
  }

  cachedServiceClient = createServiceClient();

  return cachedServiceClient;
}
