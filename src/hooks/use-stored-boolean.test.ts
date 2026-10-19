import { describe, expect, it } from 'vitest';
import { readStoredBoolean, writeStoredBoolean } from './use-stored-boolean';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

const throwing = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('readStoredBoolean', () => {
  it('returns the fallback when nothing is stored', () => {
    expect(readStoredBoolean(fakeStorage(), 'k1', true)).toBe(true);
    expect(readStoredBoolean(undefined, 'k1', false)).toBe(false);
  });

  it('parses a stored value', () => {
    expect(readStoredBoolean(fakeStorage({ k2: 'false' }), 'k2', true)).toBe(
      false
    );
    expect(readStoredBoolean(fakeStorage({ k2: 'true' }), 'k2', false)).toBe(
      true
    );
  });

  it('falls back when storage throws', () => {
    expect(readStoredBoolean(throwing, 'k3', true)).toBe(true);
  });
});

describe('writeStoredBoolean', () => {
  it('round-trips through storage', () => {
    const storage = fakeStorage();
    writeStoredBoolean(storage, 'k4', false);
    expect(storage.getItem('k4')).toBe('false');
    expect(readStoredBoolean(storage, 'k4', true)).toBe(false);
  });

  it('keeps the value in memory when storage throws', () => {
    writeStoredBoolean(throwing, 'k5', false);
    expect(readStoredBoolean(throwing, 'k5', true)).toBe(false);
    // A later successful write clears the in-memory override.
    const storage = fakeStorage();
    writeStoredBoolean(storage, 'k5', true);
    expect(readStoredBoolean(fakeStorage({ k5: 'false' }), 'k5', true)).toBe(
      false
    );
  });
});
