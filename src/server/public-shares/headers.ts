const permissionsPolicy = [
  "accelerometer=()",
  "ambient-light-sensor=()",
  "autoplay=()",
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "payment=()",
  "usb=()",
].join(", ");

export function publicShareResponseHeaders(overrides?: HeadersInit): Headers {
  const headers = new Headers({
    "Cache-Control": "private, no-store, max-age=0",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": permissionsPolicy,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
  });
  if (overrides !== undefined) {
    new Headers(overrides).forEach((value, key) => headers.set(key, value));
  }
  return headers;
}
