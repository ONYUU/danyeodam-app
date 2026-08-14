'use strict';

const APP_ENVIRONMENTS = [
  'development',
  'e2e',
  'preview',
  'production',
];
const LOCAL_API_BASE_URL = 'http://127.0.0.1:3000';
const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_SUPABASE_PUBLISHABLE_KEY = 'local-development-publishable-key';

function parseAppEnvironment(value) {
  const candidate = value?.trim() || 'development';

  if (APP_ENVIRONMENTS.includes(candidate)) {
    return candidate;
  }

  throw new Error(
    `APP_ENV must be one of ${APP_ENVIRONMENTS.join(', ')}; received ${candidate}.`,
  );
}

function parseIpv4(hostname) {
  const octets = hostname.split('.');
  if (octets.length !== 4 || octets.some((octet) => !/^\d+$/.test(octet))) {
    return null;
  }

  const numbers = octets.map(Number);
  if (numbers.some((octet) => octet < 0 || octet > 255)) {
    return null;
  }

  return numbers;
}

function isPrivateNetworkHostname(rawHostname) {
  const hostname = rawHostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');

  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  ) {
    return true;
  }

  const ipv4 = parseIpv4(hostname);
  if (ipv4) {
    const [first, second] = ipv4;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    );
  }

  if (hostname.includes(':')) {
    if (hostname === '::' || hostname === '::1') {
      return true;
    }
    if (/^(fc|fd|fe[89abcdef])/.test(hostname)) {
      return true;
    }
    const mappedIpv4 = hostname.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (mappedIpv4) {
      return isPrivateNetworkHostname(mappedIpv4);
    }
    const mappedHex = hostname.match(
      /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
    );
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1], 16);
      const low = Number.parseInt(mappedHex[2], 16);
      return isPrivateNetworkHostname(
        [high >> 8, high & 255, low >> 8, low & 255].join('.'),
      );
    }
    return false;
  }

  return false;
}

function parseApiBaseUrl(value, appEnvironment) {
  const candidate =
    value?.trim() ||
    (appEnvironment === 'development' || appEnvironment === 'e2e'
      ? LOCAL_API_BASE_URL
      : undefined);

  if (!candidate) {
    throw new Error(
      'EXPO_PUBLIC_API_BASE_URL is required for preview and production builds.',
    );
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('EXPO_PUBLIC_API_BASE_URL must be an absolute http(s) URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('EXPO_PUBLIC_API_BASE_URL must use http or https.');
  }

  if (parsed.username || parsed.password) {
    throw new Error('EXPO_PUBLIC_API_BASE_URL must not contain credentials.');
  }

  const isPublicBuild =
    appEnvironment === 'preview' || appEnvironment === 'production';
  if (isPublicBuild && parsed.protocol !== 'https:') {
    throw new Error('Preview and production API endpoints must use https.');
  }
  if (isPublicBuild && isPrivateNetworkHostname(parsed.hostname)) {
    throw new Error(
      'Preview and production API endpoints must not use localhost or a private network address.',
    );
  }
  if (isPublicBuild && (parsed.search || parsed.hash)) {
    throw new Error(
      'Preview and production API endpoints must not include a query or fragment.',
    );
  }

  return parsed.toString().replace(/\/$/, '');
}

function parseSupabaseUrl(value, appEnvironment) {
  const candidate =
    value?.trim() ||
    (appEnvironment === 'development' || appEnvironment === 'e2e'
      ? LOCAL_SUPABASE_URL
      : undefined);
  if (!candidate) {
    throw new Error(
      'EXPO_PUBLIC_SUPABASE_URL is required for preview and production builds.',
    );
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('EXPO_PUBLIC_SUPABASE_URL must be an absolute http(s) URL.');
  }

  const isPublicBuild =
    appEnvironment === 'preview' || appEnvironment === 'production';
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('EXPO_PUBLIC_SUPABASE_URL must use http or https.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('EXPO_PUBLIC_SUPABASE_URL must not contain credentials.');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(
      'EXPO_PUBLIC_SUPABASE_URL must not contain a path, query, or fragment.',
    );
  }
  if (isPublicBuild && parsed.protocol !== 'https:') {
    throw new Error('Preview and production Supabase endpoints must use https.');
  }
  if (isPublicBuild && isPrivateNetworkHostname(parsed.hostname)) {
    throw new Error(
      'Preview and production Supabase endpoints must not use localhost or a private network address.',
    );
  }
  return parsed.toString().replace(/\/$/, '');
}

function decodeJwtPayload(candidate) {
  const segments = candidate.split('.');
  if (segments.length !== 3) {
    return null;
  }
  try {
    const base64 = segments[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(segments[1].length / 4) * 4, '=');
    const json = typeof globalThis.atob === 'function'
      ? globalThis.atob(base64)
      : typeof globalThis.Buffer !== 'undefined'
        ? globalThis.Buffer.from(base64, 'base64').toString('utf8')
        : null;
    if (json === null) {
      return null;
    }
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function parseSupabasePublishableKey(value, appEnvironment) {
  const isLocal =
    appEnvironment === 'development' || appEnvironment === 'e2e';
  const candidate = value?.trim() || (isLocal
    ? LOCAL_SUPABASE_PUBLISHABLE_KEY
    : undefined);
  if (!candidate) {
    throw new Error(
      'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required for preview and production builds.',
    );
  }
  if (candidate.startsWith('sb_secret_')) {
    throw new Error('A Supabase secret key must never be bundled into the app.');
  }
  if (isLocal) {
    return candidate;
  }
  if (candidate.startsWith('sb_publishable_') && candidate.length >= 24) {
    return candidate;
  }

  const payload = decodeJwtPayload(candidate);
  if (payload?.role === 'anon') {
    return candidate;
  }
  throw new Error(
    'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be a publishable key or legacy anon key.',
  );
}

function parsePolicyAllowedOrigins(value, appEnvironment) {
  const candidates = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const isPublicBuild =
    appEnvironment === 'preview' || appEnvironment === 'production';
  if (isPublicBuild && candidates.length === 0) {
    throw new Error(
      'EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS is required for preview and production builds.',
    );
  }
  if (candidates.length > 8) {
    throw new Error('EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS accepts at most 8 origins.');
  }

  const origins = candidates.map((candidate) => {
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error(
        'EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS must contain absolute HTTPS origins.',
      );
    }
    if (
      parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
      || isPrivateNetworkHostname(parsed.hostname)
    ) {
      throw new Error(
        'EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS must contain public HTTPS origins without paths, credentials, queries, or fragments.',
      );
    }
    return parsed.origin;
  });
  if (new Set(origins).size !== origins.length) {
    throw new Error('EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS must not contain duplicates.');
  }
  return origins;
}

function resolvePublicEnvironment(input) {
  const appEnvironment = parseAppEnvironment(input.APP_ENV);

  return {
    appEnvironment,
    apiBaseUrl: parseApiBaseUrl(
      input.EXPO_PUBLIC_API_BASE_URL,
      appEnvironment,
    ),
    supabaseUrl: parseSupabaseUrl(
      input.EXPO_PUBLIC_SUPABASE_URL,
      appEnvironment,
    ),
    supabasePublishableKey: parseSupabasePublishableKey(
      input.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      appEnvironment,
    ),
    policyAllowedOrigins: parsePolicyAllowedOrigins(
      input.EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS,
      appEnvironment,
    ),
  };
}

module.exports = {
  APP_ENVIRONMENTS,
  isPrivateNetworkHostname,
  parseApiBaseUrl,
  parseAppEnvironment,
  parseSupabasePublishableKey,
  parseSupabaseUrl,
  parsePolicyAllowedOrigins,
  resolvePublicEnvironment,
};
