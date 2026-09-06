// idb.test.ts — the IndexedDB store against fake-indexeddb: `load` after `putOps` returns every op
// (property, in random chunks, against a direct replay); `compact` then `load` is the same document
// on canonical bytes, sv and pending, with foreign ops pruned and EVERY op of the device's own ids
// kept (E38); the D4 promise — a transaction aborted between the snapshot write and the prune
// leaves everything as it was; `putOps` resolves only after the transaction's `complete` event
// (I10), and a quota error mid-write rejects with the browser's error instead of vanishing;
// `persisted()` asks `navigator.storage.persist()` once and caches, `persist()` asks again;
// `indexedDB.open` failing falls back to memory with the `storage: 'memory'` flag; and what comes
// back from disk is treated as hostile: a snapshot with `__proto__` keys, a bad `meta.me`, a bad
// `meta.synced` are each refused as StoreCorruptError — the error card's `Start fresh` path.
import 'fake-indexeddb/auto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalString, emptyDoc, localInsert, pendingCount, svEqual, visibleItems, type Doc, type Op, type ReplicaId, type StateVector } from '@weft/crdt';
import { openIdbStore, StoreCorruptError, type OpenedStore } from '../../src/store/idb.ts';

const A = 'bcdefghijklmn' as ReplicaId;
const B = 'cdefghijklmno' as ReplicaId;
const C = 'defghijklmnop' as ReplicaId;
const DOC = 'doc-idb-00001';
const numRuns = process.env['CI'] ? 1_000 : 150;

/** Type `text` at `index` on `doc` as `me`, continuing from the doc's own seq for `me`. */
function type(doc: Doc, me: ReplicaId, index: number, text: string): { ops: Op[]; doc: Doc } {
  const ops: Op[] = [];
  let cur = doc;
  let at = index;
  for (const ch of text) {
    const seq = (Object.hasOwn(cur.sv, me) ? (cur.sv as Readonly<Record<string, number>>)[me] ?? 0 : 0) + 1;
    const step = localInsert(cur, me, seq, at++, { kind: 'char', text: ch });
    ops.push(...step.ops);
    cur = step.doc;
  }
  return { ops, doc: cur };
}
const text = (doc: Doc): string => visibleItems(doc).map((i) => (i.content.kind === 'char' ? i.content.text : '▮')).join('');

const opened: OpenedStore[] = [];
/** A store on `factory` claiming `me`; `storage` is what `navigator.storage` would be. */
async function open(factory: IDBFactory, me: ReplicaId = A, storageManager: StorageManager | null = null, docId = DOC): Promise<OpenedStore> {
  const o = await openIdbStore(docId, { claim: async () => me, indexedDB: factory, storageManager });
  opened.push(o);
  return o;
}
afterEach(() => {
  for (const o of opened.splice(0)) o.store.close();
  vi.restoreAllMocks();
});

/** Write raw records the way an attacker with the profile — or a bug in a past version — would. */
function rawWrite(factory: IDBFactory, storeName: string, key: IDBValidKey, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = factory.open(`weft:${DOC}`, 1);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

describe('load after putOps', () => {
  it('is null for a database nothing was written to — the claimed id is recorded, the document is still "fresh"', async () => {
    const f = new IDBFactory();
    const { store, me, storage } = await open(f);
    expect(me).toBe(A);
    expect(storage).toEqual({ kind: 'idb' });
    expect(await store.load()).toBeNull();
  });

  it('returns every op, the identity and the acknowledged vector, across a close and a reopen of the same database', async () => {
    const f = new IDBFactory();
    const first = await open(f);
    const { ops } = type(emptyDoc(), A, 0, 'hey');
    await first.store.putOps(ops);
    await first.store.markAcked({ [A]: 2 } as StateVector);
    first.store.close();
    const again = await open(f);
    const loaded = await again.store.load();
    expect(loaded?.me).toBe(A);
    expect(loaded?.acked).toEqual({ [A]: 2 });
    expect(text(loaded?.doc as Doc)).toBe('hey');
    expect((await again.store.unacked()).map((op) => op.id.seq)).toEqual([3]);
    expect(again.store.opLog().get(A, 1, 9).map((op) => op.id.seq)).toEqual([1, 2, 3]);
  });

  it('property: load after putOps in random chunks, own and foreign ops mixed, equals a direct replay on canonical bytes and sv', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 24, unit: fc.constantFrom('a', 'b', 'c') }), fc.string({ minLength: 0, maxLength: 12, unit: fc.constantFrom('x', 'y') }), fc.integer({ min: 1, max: 7 }), async (mine, theirs, chunk) => {
        const f = new IDBFactory();
        const { store } = await open(f);
        const a = type(emptyDoc(), A, 0, mine);
        const b = type(a.doc, B, mine.length, theirs);
        const all = [...b.ops, ...a.ops]; // foreign first: their parent arrives later in the scan
        for (let i = 0; i < all.length; i += chunk) await store.putOps(all.slice(i, i + chunk));
        const loaded = await store.load();
        expect(canonicalString(loaded?.doc as Doc)).toBe(canonicalString(b.doc));
        expect(svEqual((loaded?.doc as Doc).sv, b.doc.sv)).toBe(true);
        store.close();
      }),
      { numRuns },
    );
  });

  it('markAcked merges into the vector another tab may have written (read-modify-write in one transaction), and acks only move forward', async () => {
    const f = new IDBFactory();
    const one = await open(f, A);
    const two = await open(f, B);
    await one.store.markAcked({ [A]: 4 } as StateVector);
    await two.store.markAcked({ [B]: 7 } as StateVector);
    await one.store.markAcked({ [A]: 2 } as StateVector);
    const { ops } = type(emptyDoc(), A, 0, 'x');
    await one.store.putOps(ops);
    expect((await one.store.load())?.acked).toEqual({ [A]: 4, [B]: 7 });
  });
});

describe('compact ⟨D4⟩ and E38', () => {
  async function seeded(f: IDBFactory): Promise<{ store: OpenedStore['store']; before: Doc }> {
    const { store } = await open(f);
    const mine = type(emptyDoc(), A, 0, 'abc');
    const theirs = type(mine.doc, B, 3, 'xyz');
    const more = type(theirs.doc, C, 6, 'q');
    await store.putOps([...mine.ops, ...theirs.ops, ...more.ops]);
    await store.markAcked({ [A]: 1 } as StateVector);
    return { store, before: (await store.load())?.doc as Doc };
  }

  it('compact then load ≡ before on canonical bytes, sv and pending; foreign ops pruned from disk and log; EVERY own op kept, acknowledged or not', async () => {
    const f = new IDBFactory();
    const { store, before } = await seeded(f);
    await store.compact(before);
    expect(store.opLog().get(B, 1, 9)).toEqual([]);
    expect(store.opLog().get(C, 1, 9)).toEqual([]);
    expect(store.opLog().get(A, 1, 9).map((op) => op.id.seq)).toEqual([1, 2, 3]);
    expect((await store.unacked()).map((op) => op.id.seq)).toEqual([2, 3]);
    const after = (await store.load())?.doc as Doc;
    expect(canonicalString(after)).toBe(canonicalString(before));
    expect(svEqual(after.sv, before.sv)).toBe(true);
    expect(pendingCount(after)).toBe(pendingCount(before));
    // From disk, not from this store's memory: a fresh connection sees the same.
    store.close();
    const again = await open(f);
    const reloaded = (await again.store.load())?.doc as Doc;
    expect(canonicalString(reloaded)).toBe(canonicalString(before));
    expect(again.store.opLog().get(A, 1, 9)).toHaveLength(3);
    expect(again.store.opLog().get(B, 1, 9)).toEqual([]);
    const next = type(reloaded, A, 7, '!');
    await again.store.putOps(next.ops);
    expect(text((await again.store.load())?.doc as Doc)).toBe('abcxyzq!');
  });

  it('E38 across tabs: the ops of every replica id this device has used are kept, including an id another tab recorded after this store opened', async () => {
    const f = new IDBFactory();
    const { store, before } = await seeded(f);
    const other = await open(f, B); // a second tab on this device writes as B
    other.store.close();
    await store.compact(before);
    expect(store.opLog().get(B, 1, 9).map((op) => op.id.seq)).toEqual([1, 2, 3]);
    expect(store.opLog().get(C, 1, 9)).toEqual([]);
  });

  it('a parked op survives compaction inside the snapshot and drains when its dependency arrives', async () => {
    const f = new IDBFactory();
    const { store } = await open(f, B);
    const a = type(emptyDoc(), A, 0, 'a');
    const orphan = type(a.doc, B, 1, 'b').ops;
    await store.putOps(orphan);
    const loaded = (await store.load())?.doc as Doc;
    expect(pendingCount(loaded)).toBe(1);
    await store.compact(loaded);
    const reloaded = (await store.load())?.doc as Doc;
    expect(pendingCount(reloaded)).toBe(1);
    await store.putOps(a.ops);
    expect(text((await store.load())?.doc as Doc)).toBe('ab');
  });

  it('interrupted path (D4): a transaction aborted between the snapshot write and the prune loses nothing — no snapshot, every op still there', async () => {
    const f = new IDBFactory();
    const { store, before } = await seeded(f);
    const realDelete = IDBObjectStore.prototype.delete;
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementationOnce(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      const req = realDelete.call(this, key);
      this.transaction.abort(); // the process dies with the snapshot written and the prune half done
      return req;
    });
    await expect(store.compact(before)).rejects.toThrow(/abort/i);
    expect(store.opLog().get(B, 1, 9)).toHaveLength(3);
    store.close();
    const again = await open(f);
    const reloaded = (await again.store.load())?.doc as Doc;
    expect(canonicalString(reloaded)).toBe(canonicalString(before));
    expect(again.store.opLog().get(B, 1, 9)).toHaveLength(3);
    expect(again.store.opLog().get(C, 1, 9)).toHaveLength(1);
    await again.store.compact(reloaded); // and the retry succeeds
    expect(again.store.opLog().get(B, 1, 9)).toEqual([]);
  });
});

describe('putOps ordering (I10, client side)', () => {
  it('resolves only after the transaction’s complete event — the request’s success alone is not enough', async () => {
    const f = new IDBFactory();
    const { store } = await open(f);
    const seen: string[] = [];
    const realTransaction = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
      const tx = realTransaction.apply(this, args);
      tx.addEventListener('complete', () => seen.push('complete'));
      const realStore = tx.objectStore.bind(tx);
      tx.objectStore = (name) => {
        const s = realStore(name);
        const realPut = s.put.bind(s);
        s.put = (value, key) => {
          const req = realPut(value, key);
          req.addEventListener('success', () => seen.push('request'));
          return req;
        };
        return s;
      };
      return tx;
    });
    await store.putOps(type(emptyDoc(), A, 0, 'ab').ops).then(() => seen.push('resolved'));
    expect(seen).toEqual(['request', 'request', 'complete', 'resolved']);
  });

  it('attack: a quota error mid-putOps rejects with the browser’s error and holds nothing — never swallowed, never half-held', async () => {
    const f = new IDBFactory();
    const { store } = await open(f);
    const quota = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (this: IDBObjectStore) {
      throw quota;
    });
    await expect(store.putOps(type(emptyDoc(), A, 0, 'ab').ops)).rejects.toBe(quota);
    expect(store.opLog().get(A, 1, 9)).toEqual([]);
    expect(await store.load()).toBeNull();
  });
});

describe('persisted() and persist()', () => {
  it('asks navigator.storage.persist() once and caches; persist() asks again and the new answer replaces the cached one', async () => {
    const f = new IDBFactory();
    const answers = [false, true];
    const persist = vi.fn(async () => answers.shift() ?? true);
    const { store } = await open(f, A, { persist } as unknown as StorageManager);
    expect(await store.persisted()).toBe(false);
    expect(await store.persisted()).toBe(false);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(await store.persist()).toBe(true);
    expect(await store.persisted()).toBe(true);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('is false when the browser has no navigator.storage, and false when persist() rejects — a promise the browser cannot make is not one Weft makes', async () => {
    const f = new IDBFactory();
    expect(await (await open(f)).store.persisted()).toBe(false);
    const refusing = { persist: async () => Promise.reject(new Error('not allowed')) } as unknown as StorageManager;
    expect(await (await open(new IDBFactory(), A, refusing)).store.persisted()).toBe(false);
  });
});

describe('denied path: IndexedDB unavailable', () => {
  it('open throwing → memoryStore with storage: memory and the reason; the claim still runs with no used ids', async () => {
    const throwing = { open: () => { throw new DOMException('denied', 'SecurityError'); } } as unknown as IDBFactory;
    const claimed: ReplicaId[][] = [];
    const o = await openIdbStore(DOC, { claim: async (used) => (claimed.push([...used]), A), indexedDB: throwing, storageManager: null });
    expect(o.storage).toEqual({ kind: 'memory', reason: 'SecurityError: denied' });
    expect(o.me).toBe(A);
    expect(claimed).toEqual([[]]);
    expect(await o.store.persisted()).toBe(false);
    await o.store.putOps(type(emptyDoc(), A, 0, 'm').ops);
    expect(text((await o.store.load())?.doc as Doc)).toBe('m');
  });

  it('open erroring asynchronously → the same fallback; no indexedDB at all → the same fallback', async () => {
    const erroring = {
      open: () => {
        const req = { error: new DOMException('backing store', 'UnknownError') } as unknown as IDBOpenDBRequest & { onerror: (() => void) | null };
        setTimeout(() => req.onerror?.(), 0);
        return req;
      },
    } as unknown as IDBFactory;
    expect((await openIdbStore(DOC, { claim: async () => A, indexedDB: erroring, storageManager: null })).storage).toEqual({ kind: 'memory', reason: 'UnknownError: backing store' });
    expect((await openIdbStore(DOC, { claim: async () => A, indexedDB: null, storageManager: null })).storage).toEqual({ kind: 'memory', reason: 'Error: this browser exposes no indexedDB' });
  });
});

describe('attack: what comes back from disk is hostile until validated', () => {
  it('a snapshot with __proto__ keys is refused as StoreCorruptError naming the snapshot — the Start fresh path — and the database is left as it was', async () => {
    const f = new IDBFactory();
    const good = await open(f);
    await good.store.putOps(type(emptyDoc(), A, 0, 'ok').ops);
    good.store.close();
    const hostile = JSON.parse(`{"v":1,"sv":{"${A}":1},"formatLamport":0,"items":[{"id":{"replica":"${A}","seq":1},"parent":{"replica":"aaaaaaaaaaaaa","seq":0},"side":"R","content":{"kind":"char","text":"x"},"deleted":false,"marks":{"__proto__":{"active":true,"lamport":1,"replica":"${A}","seq":1}}}],"pending":[]}`) as unknown;
    await rawWrite(f, 'snapshot', 'latest', hostile);
    const again = await open(f);
    const failure = await again.store.load().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(StoreCorruptError);
    expect((failure as Error).message).toMatch(/snapshot refused \(TypeError: invalid snapshot/);
    expect(((failure as Error).cause as Error).message).toMatch(/mark/);
    // Nothing was changed: the ops are still there for a Start fresh copy or a later repair.
    expect(again.store.opLog().get(A, 1, 9)).toEqual([]); // load threw before filling the log — the doc was never built
  });

  it('a meta.me that is not a list of replica ids, or a meta.synced that is not a state vector, is refused the same way', async () => {
    const f = new IDBFactory();
    (await open(f)).store.close(); // creates the schema the raw write needs
    await rawWrite(f, 'meta', 'me', JSON.parse(`{"__proto__":["${A}"]}`) as unknown);
    await expect(open(f)).rejects.toBeInstanceOf(StoreCorruptError);
    const g = new IDBFactory();
    const o = await open(g);
    await rawWrite(g, 'meta', 'synced', { constructor: 1 });
    await expect(o.store.load()).rejects.toThrow(/meta\.synced\[constructor\] is not a seq/);
    await rawWrite(g, 'meta', 'synced', [1]);
    await expect(o.store.load()).rejects.toThrow(/not a state vector/);
    await rawWrite(g, 'meta', 'synced', {});
    await rawWrite(g, 'ops', ['zz', 1], { t: 'ins' });
    await expect(o.store.load()).rejects.toThrow(/an ops record has no id/);
  });

  it('a malformed op record with an id is not trusted either: apply refuses it and the document is built from the rest', async () => {
    const f = new IDBFactory();
    const o = await open(f);
    await o.store.putOps(type(emptyDoc(), A, 0, 'ok').ops);
    await rawWrite(f, 'ops', [B, 1], { t: 'ins', id: { replica: B, seq: 1 }, parent: 'nowhere', side: 'R', content: { kind: 'char', text: 'z' } });
    const loaded = (await o.store.load())?.doc as Doc;
    expect(text(loaded)).toBe('ok');
    expect(pendingCount(loaded)).toBe(0);
  });
});
