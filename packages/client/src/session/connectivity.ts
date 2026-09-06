// connectivity.ts — the browser's own word on whether there is a network, as a value and a
// subscription. This file exists so the runner can turn `navigator.onLine` and the `online` /
// `offline` window events into BROWSER_ONLINE / BROWSER_OFFLINE (LLD §4) without knowing about
// `window`, and so a test can flip the network with a fake. The browser's report is advisory —
// `onLine: true` only means "not known to be offline" — which is why the reducer treats it as a
// reason to try, never as proof, and why the user's own toggle outranks it. It must never poll
// and never read anything but the two events and the flag.

export interface Connectivity {
  readonly online: boolean;
  /** Called with the new value on every change; returns the unsubscribe. */
  subscribe(listener: (online: boolean) => void): () => void;
}

export function browserConnectivity(win: Window): Connectivity {
  return {
    get online() {
      return win.navigator.onLine;
    },
    subscribe(listener) {
      const up = (): void => listener(true);
      const down = (): void => listener(false);
      win.addEventListener('online', up);
      win.addEventListener('offline', down);
      return () => {
        win.removeEventListener('online', up);
        win.removeEventListener('offline', down);
      };
    },
  };
}
