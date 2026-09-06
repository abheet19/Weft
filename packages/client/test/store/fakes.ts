// fakes.ts — the two browser primitives the store layer takes as parameters, faked for tests: a
// Web Locks `LockManager` whose locks are held until the granted callback's promise settles (the
// real one's contract, and what lets two "tabs" in one process contend for a replica id), and a
// `Storage` over a Map. Both are per test; the lock manager is shared between the windows of a
// two-tab test the way one browser profile shares it.

/** Held names → the release that frees them; `request` with `ifAvailable` answers `null` for a held name, like the browser. */
export function fakeLocks(): LockManager & { held(): string[] } {
  const held = new Map<string, () => void>();
  async function request(name: string, a: LockOptions | LockGrantedCallback<unknown>, b?: LockGrantedCallback<unknown>): Promise<unknown> {
    const options: LockOptions = typeof a === 'function' ? {} : a;
    const callback = (typeof a === 'function' ? a : b) as LockGrantedCallback<unknown>;
    if (held.has(name)) {
      if (options.ifAvailable === true) return callback(null);
      throw new Error(`fake LockManager: ${name} is held and this fake does not queue`);
    }
    held.set(name, () => undefined);
    // The lock is held until the granted callback's promise settles (the real contract). Free it the
    // moment that promise settles — attached directly, not via a race + finally, so a released lock is
    // gone within one microtask (what a caller's `await Promise.resolve()` after release() observes).
    const result = callback({ name, mode: 'exclusive' });
    void Promise.resolve(result).then(
      () => held.delete(name),
      () => held.delete(name),
    );
    return result;
  }
  return {
    request: request as LockManager['request'],
    query: async () => ({ held: [...held.keys()].map((name) => ({ name, mode: 'exclusive' as const })), pending: [] }),
    held: () => [...held.keys()],
  };
}

export function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
  };
}
