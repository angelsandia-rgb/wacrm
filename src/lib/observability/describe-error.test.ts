import { describe, it, expect } from 'vitest';
import { describeError, isUndefinedColumnError } from './describe-error';

describe('describeError', () => {
  it('reads .message off an Error', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('passes a string straight through', () => {
    expect(describeError('plain')).toBe('plain');
  });

  it('assembles a PostgREST error instead of "[object Object]"', () => {
    const pgErr = {
      message: 'column conversations.ai_flow_directive does not exist',
      code: '42703',
      details: null,
      hint: 'Perhaps you meant to reference the column "conversations.ai_handoff_at".',
    };
    const out = describeError(pgErr);
    expect(out).toContain('ai_flow_directive does not exist');
    expect(out).toContain('[42703]');
    expect(out).toContain('Perhaps you meant');
    expect(out).not.toContain('[object Object]');
  });

  it('falls back to JSON for an object with no known string field', () => {
    const out = describeError({ weird: 1, nested: { a: true } });
    expect(out).not.toContain('[object Object]');
    expect(out).toContain('weird');
  });

  it('never returns a bare "[object Object]" for a plain object', () => {
    expect(describeError({})).toBe('{}');
    expect(describeError({})).not.toBe('[object Object]');
  });
});

describe('isUndefinedColumnError', () => {
  it('matches SQLSTATE 42703', () => {
    expect(isUndefinedColumnError({ code: '42703', message: 'x' })).toBe(true);
  });

  it('matches the "column ... does not exist" message without a code', () => {
    expect(
      isUndefinedColumnError({ message: 'column "foo" does not exist' }),
    ).toBe(true);
  });

  it('does not match an unrelated error', () => {
    expect(isUndefinedColumnError(new Error('network down'))).toBe(false);
    expect(isUndefinedColumnError({ code: '23505', message: 'dup key' })).toBe(false);
    expect(isUndefinedColumnError(null)).toBe(false);
  });
});
