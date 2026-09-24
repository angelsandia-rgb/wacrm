import { describe, expect, it } from 'vitest';
import { buildCsp, generateNonce } from './csp';

const directive = (csp: string, name: string) =>
  csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? '';

describe('buildCsp', () => {
  it('gates scripts on the nonce, never on unsafe-inline', () => {
    const script = directive(buildCsp('abc123', false), 'script-src');
    expect(script).toContain("'nonce-abc123'");
    expect(script).toContain("'strict-dynamic'");
    expect(script).not.toContain('unsafe-inline');
    expect(script).not.toContain('unsafe-eval');
  });

  it('adds unsafe-eval only in development', () => {
    expect(directive(buildCsp('n', true), 'script-src')).toContain("'unsafe-eval'");
  });

  it('keeps the non-script hardening', () => {
    const csp = buildCsp('n', false);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
  });
});

describe('generateNonce', () => {
  it('is 128-bit base64 and unique per call', () => {
    const a = generateNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(new Set(Array.from({ length: 50 }, generateNonce)).size).toBe(50);
  });
});
