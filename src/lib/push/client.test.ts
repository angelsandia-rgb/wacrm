import { describe, it, expect, vi, afterEach } from 'vitest';
import { urlBase64ToUint8Array, getPushState, subscribeToPush } from './client';

afterEach(() => { vi.unstubAllGlobals(); });

function setup(subscription: object | null = { endpoint: 'device' }, saved = true) {
  const subscribe = vi.fn().mockResolvedValue({ endpoint: 'new-device' });
  const registration = {pushManager:{getSubscription:vi.fn().mockResolvedValue(subscription),subscribe}};
  vi.stubGlobal('window',{PushManager: class {},Notification:class {}});
  vi.stubGlobal('Notification',{permission:'granted'});
  vi.stubGlobal('navigator',{serviceWorker:{ready:Promise.resolve(registration)}});
  const fetcher=vi.fn().mockImplementation((url:string)=>Promise.resolve(url.includes('vapid-public-key')
    ? {ok:true,json:async()=>({key:'aGVsbG8',configured:true})} : {ok:saved}));
  vi.stubGlobal('fetch',fetcher);
  return {fetcher,subscribe};
}

describe('push registration status',()=>{
  it('registers with runtime keys without a build-time key',async()=>{
    const {subscribe,fetcher}=setup(null);
    expect(await subscribeToPush()).toBe(true);
    expect(subscribe).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith('/api/push/subscribe',expect.objectContaining({method:'POST'}));
  });
  it('does not report active when saving the local subscription fails',async()=>{
    setup(undefined,false);
    expect(await getPushState()).toBe('error');
  });
  it('reports active after server registration succeeds',async()=>{
    setup();expect(await getPushState()).toBe('on');
  });
  it('reports configuration failure and missing server keys explicitly',async()=>{
    const {fetcher}=setup();fetcher.mockRejectedValueOnce(new Error('offline'));
    expect(await getPushState()).toBe('error');
    fetcher.mockResolvedValueOnce({ok:true,json:async()=>({key:'public',configured:false})});
    expect(await getPushState()).toBe('unconfigured');
  });
});

describe('urlBase64ToUint8Array', () => {
  it('decodes a url-safe base64 string to the right bytes', () => {
    // "hello" -> base64 "aGVsbG8=" -> url-safe "aGVsbG8" (no padding)
    const out = urlBase64ToUint8Array('aGVsbG8');
    expect(Array.from(out)).toEqual([104, 101, 108, 108, 111]);
  });

  it('handles url-safe chars (- and _) and missing padding', () => {
    // bytes [251, 255, 191] -> base64 "+/+/" -> url-safe "-_-_"
    const out = urlBase64ToUint8Array('-_-_');
    expect(Array.from(out)).toEqual([251, 255, 191]);
  });

  it('round-trips a realistic-length VAPID key', () => {
    const bytes = new Uint8Array(65).map((_, i) => (i * 7) % 256);
    const b64 = Buffer.from(bytes)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(Array.from(urlBase64ToUint8Array(b64))).toEqual(Array.from(bytes));
  });
});
