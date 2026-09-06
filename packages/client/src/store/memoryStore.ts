// memoryStore.ts — the Store interface every client persistence layer implements, and its
// in-memory implementation. This file exists so the session runner is written against one
// contract (persist, then send — I10) that tests can drive without IndexedDB and that the UI can
// fall back to when IndexedDB is unavailable — visibly, since `persisted()` and `persist()` answer
// false and the shell shows the `storage: 'memory'` flag (S4). It takes the replica id as a
// parameter because a PURE store cannot mint one (LLD extension E10). It must never resolve
// `putOps` before the ops are held, never prune an OWN op — acknowledged or not — because this
// device holds the only copy a server that lost its log can be refilled from (design §3.6, E38),
// and never touch a clock or the network.

import { applyAll, decodeSnapshot, emptyDoc, encodeSnapshot, svGet, svMerge, type Doc, type Op, type OpLog, type ReplicaId, type Snapshot, type StateVector } from '@weft/crdt';

export interface Store {
  /** Persist ops and resolve only after the IDB transaction's `complete` event. Callers MUST NOT send before this resolves (I10). */
  putOps(ops: readonly Op[]): Promise<void>;
  markAcked(sv: StateVector): Promise<void>;
  unacked(): Promise<readonly Op[]>;
  load(): Promise<{ doc: Doc; me: ReplicaId; acked: StateVector } | null>;
  /** Snapshot + prune in ONE transaction ⟨D4⟩. */
  compact(doc: Doc): Promise<void>;
  opLog(): OpLog;
  /** navigator.storage.persist() result; asked once and cached (S4, E42). The pill no longer surfaces it — persistence is requested silently — but the store-layer contract stands. */
  persisted(): Promise<boolean>;
  /** Ask the browser for durable storage; the answer replaces what `persisted()` reports. Called once, silently, on load (03-UI §4.7); the boolean drives no UI. */
  persist(): Promise<boolean>;
  /** Release the underlying connection. Nothing may be called afterwards; the shell calls it on unmount. */
  close(): void;
}

export function memoryStore(me: ReplicaId): Store {
  return new MemoryStore(me);
}

class MemoryStore implements Store {
  /** replica → (seq → op). Keyed by seq rather than positioned by it so pruning leaves no holes to reason about. */
  private readonly ops = new Map<string, Map<number, Op>>();
  private snapshot: Snapshot | null = null;
  private acked: StateVector = {};
  /** `load` answers null until something was stored, which is how a caller tells "fresh" from "empty". */
  private touched = false;
  private readonly me: ReplicaId;

  constructor(me: ReplicaId) {
    this.me = me;
  }

  async putOps(ops: readonly Op[]): Promise<void> {
    for (const op of ops) {
      const held = this.ops.get(op.id.replica) ?? new Map<number, Op>();
      held.set(op.id.seq, op);
      this.ops.set(op.id.replica, held);
    }
    this.touched = true;
  }

  async markAcked(sv: StateVector): Promise<void> {
    this.acked = svMerge(this.acked, sv);
    this.touched = true;
  }

  async unacked(): Promise<readonly Op[]> {
    const floor = svGet(this.acked, this.me);
    return this.range(this.me, floor + 1, Number.MAX_SAFE_INTEGER);
  }

  async load(): Promise<{ doc: Doc; me: ReplicaId; acked: StateVector } | null> {
    if (!this.touched) return null;
    const base = this.snapshot === null ? emptyDoc() : decodeSnapshot(this.snapshot);
    // Ops the snapshot does not cover, per replica in seq order. `apply` parks an op whose parent
    // arrives later from another replica and drains it then, so cross-replica order is immaterial.
    const rest: Op[] = [];
    for (const replica of [...this.ops.keys()].sort()) rest.push(...this.range(replica, svGet(base.sv, replica) + 1, Number.MAX_SAFE_INTEGER));
    return { doc: applyAll(base, rest).doc, me: this.me, acked: this.acked };
  }

  async compact(doc: Doc): Promise<void> {
    // In memory, "one transaction" is one synchronous step: nothing can observe the snapshot
    // without the prune, or the prune without the snapshot. Only foreign ops are pruned: the
    // server or a peer can always resend those, nobody but this replica can resend its own.
    const snapshot = encodeSnapshot(doc);
    for (const [replica, held] of this.ops) {
      if (replica === this.me) continue;
      const covered = svGet(snapshot.sv, replica);
      for (const seq of held.keys()) if (seq <= covered) held.delete(seq);
    }
    this.snapshot = snapshot;
    this.touched = true;
  }

  opLog(): OpLog {
    return { get: (replica, fromSeq, toSeq) => this.range(replica, fromSeq, toSeq) };
  }

  async persisted(): Promise<boolean> {
    return false;
  }

  async persist(): Promise<boolean> {
    return false; // memory is never durable; asking again cannot change that
  }

  close(): void {
    // Nothing to release: the ops live in this object and go with it.
  }

  /** Ops of `replica` with `fromSeq ≤ seq ≤ toSeq` that are still held, in seq order. */
  private range(replica: string, fromSeq: number, toSeq: number): Op[] {
    const held = this.ops.get(replica);
    if (held === undefined) return [];
    return [...held.keys()]
      .filter((seq) => seq >= fromSeq && seq <= toSeq)
      .sort((a, b) => a - b)
      .map((seq) => held.get(seq) as Op);
  }
}
