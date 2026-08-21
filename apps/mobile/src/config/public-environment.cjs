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
const RESERVED_PUBLIC_HOST_SUFFIXES = [
  '.invalid',
  '.example',
  '.test',
  '.localhost',
  '.internal',
  '.alt',
  '.onion',
];
const PLACEHOLDER_PUBLIC_HOSTS = [
  'example.com',
  'example.net',
  'example.org',
  'home.arpa',
];

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

function parseIpv6(hostname) {
  if (!hostname.includes(':')) return null;
  const halves = hostname.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] === '' ? [] : halves[0].split(':');
  const right = halves.length === 1 || halves[1] === ''
    ? []
    : halves[1].split(':');
  const explicitGroups = [...left, ...right];
  if (explicitGroups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return null;
  }
  const omittedGroupCount = 8 - explicitGroups.length;
  if (
    (halves.length === 1 && omittedGroupCount !== 0)
    || (halves.length === 2 && omittedGroupCount < 1)
  ) {
    return null;
  }
  return [
    ...left.map((group) => Number.parseInt(group, 16)),
    ...Array.from({ length: omittedGroupCount }, () => 0),
    ...right.map((group) => Number.parseInt(group, 16)),
  ];
}

function ipv4FromIpv6Tail(ipv6) {
  const high = ipv6[6];
  const low = ipv6[7];
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
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
    hostname.endsWith('.local') ||
    hostname === 'invalid' ||
    hostname === 'example' ||
    hostname === 'test' ||
    hostname === 'local' ||
    hostname === 'internal' ||
    hostname === 'alt' ||
    hostname === 'onion' ||
    RESERVED_PUBLIC_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    PLACEHOLDER_PUBLIC_HOSTS.some(
      (placeholder) => hostname === placeholder || hostname.endsWith(`.${placeholder}`),
    )
  ) {
    return true;
  }
  if (!hostname.includes('.') && !hostname.includes(':')) return true;

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
      (first === 192 && second === 0 && ipv4[2] === 0) ||
      (first === 192 && second === 168) ||
      (first === 192 && second === 0 && ipv4[2] === 2) ||
      (first === 192 && second === 88 && ipv4[2] === 99) ||
      (first === 198 && (second === 18 || second === 19)) ||
      (first === 198 && second === 51 && ipv4[2] === 100) ||
      (first === 203 && second === 0 && ipv4[2] === 113) ||
      first >= 224
    );
  }

  const ipv6 = parseIpv6(hostname);
  if (ipv6) {
    const [first, second, third, fourth] = ipv6;
    if (
      ipv6.every((group) => group === 0) ||
      (ipv6.slice(0, 7).every((group) => group === 0) && ipv6[7] === 1) ||
      (first & 0xfe00) === 0xfc00 ||
      (first & 0xffc0) === 0xfe80 ||
      (first & 0xff00) === 0xff00 ||
      (first === 0x0100 && second === 0 && third === 0 && fourth === 0) ||
      (first === 0x0064 && second === 0xff9b && third === 1) ||
      (first === 0x2001 && second <= 0x01ff) ||
      (first === 0x2001 && second === 0x0db8) ||
      first === 0x2002 ||
      (first === 0x3fff && (second & 0xf000) === 0) ||
      first === 0x5f00
    ) {
      return true;
    }

    const isIpv4Compatible = ipv6.slice(0, 6).every((group) => group === 0);
    const isIpv4Mapped = ipv6.slice(0, 5).every((group) => group === 0)
      && ipv6[5] === 0xffff;
    const isWellKnownNat64 = first === 0x0064
      && second === 0xff9b
      && ipv6.slice(2, 6).every((group) => group === 0);
    if (isIpv4Compatible || isIpv4Mapped) return true;
    if (isWellKnownNat64) {
      return isPrivateNetworkHostname(ipv4FromIpv6Tail(ipv6));
    }
    if ((first & 0xe000) !== 0x2000) return true;
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
      'Preview and production API endpoints must not use private, reserved, documentation, or placeholder hosts.',
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
      'Preview and production Supabase endpoints must not use private, reserved, documentation, or placeholder hosts.',
    );
  }
  return parsed.toString().replace(/\/$/, '');
}

function decodeJwtPayload(candidate) {
  const segments = candidate.split('.');
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
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
  if (/^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(candidate)) {
    if (
      /(?:replace|placeholder|example|validation|test[_-]?only|local)/i.test(candidate)
    ) {
      throw new Error(
        'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY must not be a placeholder value.',
      );
    }
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
        'EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS must contain non-placeholder public HTTPS origins without paths, credentials, queries, or fragments.',
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
