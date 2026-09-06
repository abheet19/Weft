// idb.ts — the durable Store: one IndexedDB database per document (`weft:<docId>`, design §4.1)
// with three object stores — `ops` keyed `[replica, seq]`, `meta` (`me`: the replica ids this
// device has written as; `synced`: the acknowledged state vector) and `snapshot` (`latest`). This
// file exists to keep the two ordering promises the offline story rests on in one place: `putOps`
// resolves only on the transaction's `complete` event, so the runner never sends an op the disk
// has not taken (I10, client side); `compact` writes the snapshot and prunes the ops it covers in
// ONE transaction, so a crash between the two loses nothing (D4). The op log is also held in
// memory, because `opLog().get` is synchronous by contract (crdt is pure and reads it inline);
// IndexedDB is its durable copy and `load()` is the read that fills it. Which replica id this tab
// writes as is decided by the caller's `claim` from the ids in `meta.me` (E41): a store is per
// device, a replica id per tab. When IndexedDB cannot be opened at all the store falls back to
// memory and says so through `storage.kind === 'memory'` — the UI must show it, never hide it.
// It must never prune an op of a replica id this device has used (E38: this device may be the only
// copy), never resolve a write before `complete`, never trust what it reads back — a snapshot, a
// state vector or an id list from disk is validated like wire data and a bad one is a
// StoreCorruptError the shell turns into the error card — and never read a clock.

import { applyAll, decodeSnapshot, emptyDoc, encodeSnapshot, REPLICA_ID_RE, svGet, svMerge, type Doc, type Op, type OpLog, type ReplicaId, type Snapshot, type StateVector } from '@weft/crdt';
import { memoryStore, type Store } from './memoryStore.ts';

/** Where a document's changes live on this device: IndexedDB, or — when it could not be opened — this tab's memory, with the reason. */
export type StorageKind = { readonly kind: 'idb' } | { readonly kind: 'memory'; readonly reason: string };

export interface OpenedStore {
  readonly store: Store;
  /** The replica id this tab writes as, as decided by `claim`. */
  readonly me: ReplicaId;
  readonly storage: StorageKind;
}

export interface OpenStoreOptions {
  /** Decides which replica id this tab writes as, given the ids this device has used for the document, most recent last (E41). */
  claim(used: readonly ReplicaId[]): Promise<ReplicaId>;
  /** The IndexedDB factory, or `null` when the browser exposes none. Injected so tests can share one fake between two "tabs". */
  indexedDB: IDBFactory | null;
  /** `navigator.storage`, or `null` when unavailable: `persisted()` then answers false honestly. */
  storageManager: StorageManager | null;
  /** Design §4.3: `relaxed` is the browser default (no fsync per keystroke); `strict` is exposed as a setting. */
  durability?: 'default' | 'strict';
}

/** Data read back from IndexedDB that is not what Weft wrote: the shell shows the error card with `Start fresh` (03-UI §4.9). */
export class StoreCorruptError extends Error {
  constructor(docId: string, what: string, cause: unknown) {
    super(`the copy of weft:${docId} on this device is not valid: ${what}`, { cause });
    this.name = 'StoreCorruptError';
  }
}

const DB_VERSION = 1;
const OPS = 'ops';
const META = 'meta';
const SNAPSHOT = 'snapshot';
const KEY_ME = 'me';
const KEY_SYNCED = 'synced';
const KEY_LATEST = 'latest';

export async function openIdbStore(docId: string, o: OpenStoreOptions): Promise<OpenedStore> {
  let db: IDBDatabase;
  try {
    if (o.indexedDB === null) throw new Error('this browser exposes no indexedDB');
    db = await openDatabase(o.indexedDB, `weft:${docId}`);
  } catch (e) {
    // Private mode, a denied origin, a broken profile: the session still runs, in memory, and the pill says so.
    return fallback(await o.claim([]), e);
  }
  const used = await readUsed(db, docId);
  const me = await o.claim(used);
  if (!used.includes(me)) await recordUsed(db, docId, me);
  return { store: new IdbStore(db, docId, me, o.storageManager, o.durability ?? 'default'), me, storage: { kind: 'idb' } };
}

function fallback(me: ReplicaId, e: unknown): OpenedStore {
  return { store: memoryStore(me), me, storage: { kind: 'memory', reason: describe(e) } };
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, DB_VERSION); // throws synchronously in some denied contexts; the executor turns that into a rejection
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore(OPS);
      db.createObjectStore(META);
      db.createObjectStore(SNAPSHOT);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error(`indexedDB.open(${name}) failed`));
  });
}

/** A request's result once it succeeds; its error otherwise. Requests are read inside a transaction the caller owns. */
function result<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * Run `body` in one transaction and resolve on its `complete` event — never earlier: only then has
 * the browser taken the writes (I10). An abort, including the quota error a full disk raises,
 * rejects with the transaction's error so nothing is swallowed; a `body` that throws before any
 * request aborts the transaction itself, or an empty transaction would "complete" a failed write.
 */
function transact(db: IDBDatabase, stores: readonly string[], mode: IDBTransactionMode, durability: IDBTransactionDurability, body: (tx: IDBTransaction) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode, { durability });
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    try {
      body(tx);
    } catch (e) {
      tx.abort();
      reject(e);
    }
  });
}

async function readUsed(db: IDBDatabase, docId: string): Promise<readonly ReplicaId[]> {
  const raw = await result(db.transaction(META).objectStore(META).get(KEY_ME));
  return readIdList(docId, raw);
}

/** Append `me` to `meta.me` with a read inside the same transaction: two tabs opening at once must both end up in the list. */
function recordUsed(db: IDBDatabase, docId: string, me: ReplicaId): Promise<void> {
  return transact(db, [META], 'readwrite', 'default', (tx) => {
    const meta = tx.objectStore(META);
    const get = meta.get(KEY_ME);
    get.onsuccess = () => {
      const used = readIdList(docId, get.result);
      if (!used.includes(me)) meta.put([...used, me], KEY_ME);
    };
  });
}

function readIdList(docId: string, raw: unknown): readonly ReplicaId[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((id) => typeof id === 'string' && REPLICA_ID_RE.test(id))) throw new StoreCorruptError(docId, 'meta.me is not a list of replica ids', raw);
  return raw as ReplicaId[];
}

function readSv(docId: string, raw: unknown): StateVector {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new StoreCorruptError(docId, 'meta.synced is not a state vector', raw);
  const out: Record<string, number> = {};
  for (const key of Object.keys(raw)) {
    const n = (raw as Record<string, unknown>)[key];
    if (!REPLICA_ID_RE.test(key) || !Number.isSafeInteger(n) || (n as number) < 0) throw new StoreCorruptError(docId, `meta.synced[${key}] is not a seq`, raw);
    out[key] = n as number;
  }
  return out as StateVector;
}

class IdbStore implements Store {
  /** Every op held, replica → (seq → op): the synchronous `opLog`, filled by `load()` and by each completed `putOps`. */
  private readonly held = new Map<string, Map<number, Op>>();
  private acked: StateVector = {};
  private persistedAnswer: Promise<boolean> | null = null;
  private readonly db: IDBDatabase;
  private readonly docId: string;
  private readonly me: ReplicaId;
  private readonly storage: StorageManager | null;
  private readonly durability: IDBTransactionDurability;

  constructor(db: IDBDatabase, docId: string, me: ReplicaId, storage: StorageManager | null, durability: 'default' | 'strict') {
    this.db = db;
    this.docId = docId;
    this.me = me;
    this.storage = storage;
    this.durability = durability;
  }

  async putOps(ops: readonly Op[]): Promise<void> {
    await transact(this.db, [OPS], 'readwrite', this.durability, (tx) => {
      const store = tx.objectStore(OPS);
      for (const op of ops) store.put(op, [op.id.replica, op.id.seq]);
    });
    // Only after `complete`: the in-memory log must never name an op the disk does not hold.
    for (const op of ops) this.hold(op);
  }

  markAcked(sv: StateVector): Promise<void> {
    // Read-modify-write inside one transaction: another tab acknowledges its own replica id into
    // the same vector, and a blind put would drop its entry.
    return transact(this.db, [META], 'readwrite', this.durability, (tx) => {
      const meta = tx.objectStore(META);
      const get = meta.get(KEY_SYNCED);
      get.onsuccess = () => {
        const merged = svMerge(readSv(this.docId, get.result), sv);
        this.acked = merged;
        meta.put(merged, KEY_SYNCED);
      };
    });
  }

  async unacked(): Promise<readonly Op[]> {
    return this.range(this.me, svGet(this.acked, this.me) + 1, Number.MAX_SAFE_INTEGER);
  }

  async load(): Promise<{ doc: Doc; me: ReplicaId; acked: StateVector } | null> {
    const tx = this.db.transaction([OPS, META, SNAPSHOT]);
    const [snapshot, ops, synced] = await Promise.all([result(tx.objectStore(SNAPSHOT).get(KEY_LATEST) as IDBRequest<unknown>), result(tx.objectStore(OPS).getAll() as IDBRequest<unknown[]>), result(tx.objectStore(META).get(KEY_SYNCED) as IDBRequest<unknown>)]);
    this.acked = readSv(this.docId, synced);
    if (snapshot === undefined && ops.length === 0 && synced === undefined) return null;
    const base = snapshot === undefined ? emptyDoc() : this.decode(snapshot);
    this.held.clear();
    for (const op of ops) this.hold(this.readOp(op)); // shape only: `apply` below is total over unknown (E10) and refuses a malformed op rather than trusting it
    // Ops the snapshot does not cover, per replica in seq order; `apply` parks an op whose parent
    // arrives later from another replica and drains it then, so cross-replica order is immaterial.
    const rest: Op[] = [];
    for (const replica of [...this.held.keys()].sort()) rest.push(...this.range(replica, svGet(base.sv, replica) + 1, Number.MAX_SAFE_INTEGER));
    return { doc: applyAll(base, rest).doc, me: this.me, acked: this.acked };
  }

  /** Enough of an op's shape to key it; anything less is not something this store wrote. */
  private readOp(raw: unknown): Op {
    const id = (raw as { id?: { replica?: unknown; seq?: unknown } } | null)?.id;
    if (typeof raw !== 'object' || raw === null || typeof id?.replica !== 'string' || typeof id.seq !== 'number') throw new StoreCorruptError(this.docId, 'an ops record has no id', raw);
    return raw as Op;
  }

  private decode(raw: unknown): Doc {
    try {
      return decodeSnapshot(raw as Snapshot); // decodeSnapshot treats its input as hostile whatever the annotation says
    } catch (e) {
      throw new StoreCorruptError(this.docId, `snapshot refused (${describe(e)})`, e);
    }
  }

  compact(doc: Doc): Promise<void> {
    const snapshot = encodeSnapshot(doc);
    const pruned: { replica: string; upTo: number }[] = [];
    return transact(this.db, [SNAPSHOT, OPS, META], 'readwrite', this.durability, (tx) => {
      tx.objectStore(SNAPSHOT).put(snapshot, KEY_LATEST);
      // The device's own ids are read in this same transaction: a tab that opened since this one
      // did is in the list too, and its ops are as unprunable as ours (E38).
      const get = tx.objectStore(META).get(KEY_ME);
      get.onsuccess = () => {
        const own = new Set<string>(readIdList(this.docId, get.result));
        own.add(this.me);
        const ops = tx.objectStore(OPS);
        for (const replica of Object.keys(snapshot.sv)) {
          if (own.has(replica)) continue;
          const upTo = svGet(snapshot.sv, replica);
          ops.delete(IDBKeyRange.bound([replica, 1], [replica, upTo]));
          pruned.push({ replica, upTo });
        }
      };
    }).then(() => {
      for (const { replica, upTo } of pruned) {
        const held = this.held.get(replica);
        if (held === undefined) continue;
        for (const seq of held.keys()) if (seq <= upTo) held.delete(seq);
      }
    });
  }

  opLog(): OpLog {
    return { get: (replica, fromSeq, toSeq) => this.range(replica, fromSeq, toSeq) };
  }

  persisted(): Promise<boolean> {
    this.persistedAnswer ??= this.persist();
    return this.persistedAnswer;
  }

  persist(): Promise<boolean> {
    // A browser without the API, or one that rejects the request, cannot promise to keep the data: that is a false, not a failure to hide.
    const asked = this.storage === null ? Promise.resolve(false) : this.storage.persist().catch(() => false);
    this.persistedAnswer = asked;
    return asked;
  }

  close(): void {
    this.db.close();
  }

  private hold(op: Op): void {
    const held = this.held.get(op.id.replica) ?? new Map<number, Op>();
    held.set(op.id.seq, op);
    this.held.set(op.id.replica, held);
  }

  /** Ops of `replica` with `fromSeq ≤ seq ≤ toSeq` that are held, in seq order. */
  private range(replica: string, fromSeq: number, toSeq: number): Op[] {
    const held = this.held.get(replica);
    if (held === undefined) return [];
    return [...held.keys()]
      .filter((seq) => seq >= fromSeq && seq <= toSeq)
      .sort((a, b) => a - b)
      .map((seq) => held.get(seq) as Op);
  }
}
