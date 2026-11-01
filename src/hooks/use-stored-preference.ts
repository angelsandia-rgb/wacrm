'use client';

import { useCallback, useSyncExternalStore } from 'react';

// Per-browser UI preferences in localStorage (panel open/closed, last
// calendar view, …), read through useSyncExternalStore so the server
// render and hydration always use the default and the stored value is
// swapped in right after, without a setState-in-effect pass.

// Values written while localStorage is unavailable (private browsing,
// sandboxed iframes) so a change still works for the rest of the session.
const memory = new Map<string, string>();
const listeners = new Set<() => void>();

/** Stored string for `key`, or null when nothing (readable) is stored. */
export function readStored(
  storage: Pick<Storage, 'getItem'> | undefined,
  key: string
): string | null {
  const remembered = memory.get(key);
  if (remembered !== undefined) return remembered;
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    // localStorage can throw in private-browsing / sandboxed contexts.
    return null;
  }
}

/** Persists `value` and notifies every hook reading a stored preference. */
export function writeStored(
  storage: Pick<Storage, 'setItem'> | undefined,
  key: string,
  value: string
): void {
  try {
    if (!storage) throw new Error('no storage');
    storage.setItem(key, value);
    memory.delete(key);
  } catch {
    // Persistence is best-effort; keep the value in memory instead.
    memory.set(key, value);
  }
  for (const listener of listeners) listener();
}

/** Stored boolean for `key`, or `fallback` when nothing is stored. */
export function readStoredBoolean(
  storage: Pick<Storage, 'getItem'> | undefined,
  key: string,
  fallback: boolean
): boolean {
  const stored = readStored(storage, key);
  return stored == null ? fallback : stored === 'true';
}

export function writeStoredBoolean(
  storage: Pick<Storage, 'setItem'> | undefined,
  key: string,
  value: boolean
): void {
  writeStored(storage, key, String(value));
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

export function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** A boolean persisted in localStorage under `key`, plus a toggle. */
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

/**
 * One of `choices`, persisted in localStorage under `key`, plus a setter.
 * A stored value that is no longer a valid choice reads as `defaultValue`.
 */
export function useStoredChoice<T extends string>(
  key: string,
  defaultValue: T,
  choices: readonly T[]
): [T, (next: T) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => {
      const stored = readStored(browserStorage(), key);
      return choices.includes(stored as T) ? (stored as T) : defaultValue;
    },
    () => defaultValue
  );

  const setValue = useCallback(
    (next: T) => writeStored(browserStorage(), key, next),
    [key]
  );

  return [value, setValue];
}
