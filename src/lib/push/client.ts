/** Browser-side Web Push helpers. Safe to import anywhere; every entry
 *  point guards on feature support and returns a benign value when push
 *  isn't available (old browser, no SW, keys unset). */

export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  // Explicit ArrayBuffer (not ArrayBufferLike) so this satisfies
  // `BufferSource` for `pushManager.subscribe({ applicationServerKey })`.
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

async function publicKey(): Promise<string | null> {
  // Runtime config also works when deployment keys were absent at build time.
  const res = await fetch('/api/push/vapid-public-key', { cache: 'no-store' });
  if (!res.ok) throw new Error('Push configuration unavailable');
  const data = await res.json() as { key?: string | null; configured?: boolean };
  return data.configured === false ? null : data.key || null;
}

export async function pushConfigured(): Promise<boolean> {
  if (!pushSupported()) return false;
  try { return Boolean(await publicKey()); } catch { return false; }
}

async function readyRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 10_000); }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  const reg = await readyRegistration();
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

/**
 * Ensure the browser has a push subscription and the server knows about
 * it. Idempotent — safe to call on every load. Returns true when the
 * server has a live subscription for this device afterwards.
 */
export async function subscribeToPush(): Promise<boolean> {
  const reg = await readyRegistration();
  let key: string | null;
  try { key = await publicKey(); } catch { return false; }
  if (!reg || !key) return false;

  let sub: PushSubscription | null;
  try { sub = await reg.pushManager.getSubscription(); } catch { return false; }
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    } catch {
      return false;
    }
  }

  try {
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sub),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function unsubscribeFromPush(): Promise<void> {
  const sub = await currentPushSubscription();
  if (!sub) return;
  try {
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
  } catch {
    /* server may already have pruned it */
  }
  await sub.unsubscribe().catch(() => {});
}

export type PushState = 'unsupported' | 'unconfigured' | 'denied' | 'off' | 'on' | 'error';

export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  try { if (!await publicKey()) return 'unconfigured'; } catch { return 'error'; }
  if (Notification.permission === 'denied') return 'denied';
  try {
    const sub = await currentPushSubscription();
    // A local subscription alone doesn't prove the server can send to it.
    if (Notification.permission === 'granted' && sub) return await subscribeToPush() ? 'on' : 'error';
  } catch { return 'error'; }
  return 'off';
}
