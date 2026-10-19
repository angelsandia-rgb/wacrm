'use client';

import { useCallback, useSyncExternalStore } from 'react';

// Values written while localStorage is unavailable (private browsing,
// sandboxed iframes) so a toggle still works for the rest of the session.
const memory = new Map<string, boolean>();
const listeners = new Set<() => void>();

/** Stored value for `key`, or `fallback` when nothing (readable) is stored. */
export function readStoredBoolean(
  storage: Pick<Storage, 'getItem'> | undefined,
  key: string,
  fallback: boolean
): boolean {
  const remembered = memory.get(key);
  if (remembered !== undefined) return remembered;
  try {
    const stored = storage?.getItem(key);
    if (stored != null) return stored === 'true';
  } catch {
    // localStorage can throw in private-browsing / sandboxed contexts.
  }
  return fallback;
}

/** Persists `value` and notifies every hook reading a stored boolean. */
export function writeStoredBoolean(
  storage: Pick<Storage, 'setItem'> | undefined,
  key: string,
  value: boolean
): void {
  try {
    if (!storage) throw new Error('no storage');
    storage.setItem(key, String(value));
    memory.delete(key);
  } catch {
    // Persistence is best-effort; keep the value in memory instead.
    memory.set(key, value);
  }
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Other tabs writing the same key.
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * A boolean persisted in localStorage under `key`, plus a toggle.
 *
 * The server render (and hydration) always sees `defaultValue`, so a
 * stored `false` never causes a hydration mismatch; React swaps in the
 * stored value right after hydrating, without a setState-in-effect pass.
 */
export function useStoredBoolean(
  key: string,
  defaultValue: boolean
): [boolean, () => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => readStoredBoolean(browserStorage(), key, defaultValue),
    () => defaultValue
  );

  const toggle = useCallback(() => {
    const storage = browserStorage();
    writeStoredBoolean(
      storage,
      key,
      !readStoredBoolean(storage, key, defaultValue)
    );
  }, [key, defaultValue]);

  return [value, toggle];
}
