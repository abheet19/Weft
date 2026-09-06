// @vitest-environment jsdom
// connectivity.test.ts — what the runner takes from the browser, read from a real (jsdom) window:
// `browserConnectivity` reads `navigator.onLine` and relays the `online`/`offline` events until
// unsubscribed; `browserDeps` reads the globals a window has and answers null for the ones it lacks
// (jsdom has no IndexedDB, no Web Locks, no StorageManager) or refuses (a Storage getter that throws).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newReplicaId } from '../../src/identity.ts';
import { browserConnectivity } from '../../src/session/connectivity.ts';
import { browserDeps } from '../../src/session/open.ts';

afterEach(() => vi.restoreAllMocks());

describe('browserConnectivity', () => {
  it('reads navigator.onLine and relays the two window events until unsubscribed', () => {
    const c = browserConnectivity(window);
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    expect(c.online).toBe(false);
    const seen: boolean[] = [];
    const stop = c.subscribe((online) => seen.push(online));
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    expect(seen).toEqual([false, true]);
    stop();
    window.dispatchEvent(new Event('offline'));
    expect(seen).toEqual([false, true]);
  });
});

describe('browserDeps', () => {
  it('reads the globals a window has, null for the ones it lacks or refuses', () => {
    const deps = browserDeps(window, newReplicaId);
    expect(deps.indexedDB).toBeNull();
    expect(deps.locks).toBeNull();
    expect(deps.storageManager).toBeNull();
    expect(deps.sessionStorage).toBe(window.sessionStorage);
    expect(deps.localStorage).toBe(window.localStorage);
    expect(deps.connectivity?.online).toBe(true);
    expect(deps.mint()).toMatch(/^[a-z2-7]{13}$/);
    const refusing = {
      get sessionStorage(): Storage {
        throw new DOMException('denied', 'SecurityError');
      },
      get localStorage(): Storage {
        throw new DOMException('denied', 'SecurityError');
      },
      navigator: { onLine: true },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as Window;
    expect(browserDeps(refusing, newReplicaId)).toMatchObject({ sessionStorage: null, localStorage: null, indexedDB: null, locks: null, storageManager: null });
  });
});
