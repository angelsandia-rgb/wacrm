// ============================================================
// Content-Security-Policy, built per request by the proxy.
//
// Scripts are nonce-gated: only a <script> carrying this request's
// nonce runs ('strict-dynamic' then trusts what those scripts load, i.e.
// Next's own chunks). An injected <script> — the XSS case — has no nonce
// and is blocked, which 'unsafe-inline' never did. Next.js reads the
// nonce from the request's CSP header and stamps it on its framework
// scripts; our own inline <Script> (theme boot) gets it via `x-nonce`.
//
// Styles keep 'unsafe-inline': Tailwind + React `style` attributes are
// everywhere, and a nonce can't cover style attributes anyway.
//
// A nonce requires dynamic rendering (the root layout reads headers())
// and must never be served from a shared cache — see next.config.ts.
// ============================================================

export const NONCE_HEADER = 'x-nonce';

/** 128 bits from the Web Crypto RNG, base64 — unpredictable per request. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function buildCsp(nonce: string, isDev = process.env.NODE_ENV === 'development'): string {
  return [
    "default-src 'self'",
    // 'unsafe-eval' in development only (React debugging).
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    // Tailwind + inline style attributes on lots of components.
    "style-src 'self' 'unsafe-inline'",
    // Supabase public-bucket avatars, contact avatars (arbitrary https
    // URLs paste-able from the UI), OG images, data URLs for tiny assets.
    "img-src 'self' data: blob: https:",
    // Outbound media previews (blob: from MediaRecorder + file picker)
    // and Supabase public-bucket audio/video the inbox renders.
    "media-src 'self' blob: https://*.supabase.co",
    "font-src 'self' data:",
    "object-src 'none'",
    // Service worker + the opus encoder worker for voice notes.
    "worker-src 'self' blob:",
    // Supabase REST + realtime (WSS). Meta/Zernio calls are server-side.
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/** Locked-down policy for JSON API responses — they never render HTML. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";
