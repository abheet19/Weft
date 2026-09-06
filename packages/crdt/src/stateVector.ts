// stateVector.ts — "what I hold", per replica. This file exists because contiguous per-replica
// seqs make a small map a complete description of a replica's op set, and the difference of two
// such maps is exactly the catch-up payload (design §3.2): the whole document is never re-sent.
// It must never read a state vector key without `Object.hasOwn` (an inherited `constructor`
// property is not a replica) and never trust that a key is a ReplicaId — callers validate.

import type { ReplicaId } from './ids.ts';
import type { Doc } from './doc.ts';
import type { Op } from './ops.ts';

export type StateVector = Readonly<Record<ReplicaId, number>>;

/** Read-only view over persisted ops keyed by replica; supplied by the store so crdt stays pure. */
export interface OpLog {
  /** Ops of `replica` with `fromSeq ≤ seq ≤ toSeq`, in seq order. Both ends inclusive. */
  get(replica: ReplicaId, fromSeq: number, toSeq: number): readonly Op[];
}

/** The highest seq `sv` holds for `replica`, 0 when none. Own properties only: `sv["constructor"]` must read as 0, not as a function. */
export function svGet(sv: StateVector, replica: string): number {
  return Object.hasOwn(sv, replica) ? (sv as Readonly<Record<string, number>>)[replica] ?? 0 : 0;
}

/** A new state vector equal to `sv` with `replica ↦ seq`. `sv` is not modified. */
export function svSet(sv: StateVector, replica: ReplicaId, seq: number): StateVector {
  return Object.freeze({ ...sv, [replica]: seq }) as StateVector;
}

/** Every replica named by either vector, sorted by code point so outputs are deterministic. */
function replicasOf(a: StateVector, b: StateVector): ReplicaId[] {
  const set = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  return [...set].sort() as ReplicaId[];
}

export function svDiff(mine: StateVector, theirs: StateVector): { iHave: StateVector; theyHave: StateVector } {
  // `iHave` lists, per replica, my highest seq where it exceeds theirs (they need theirs+1..mine);
  // `theyHave` is the mirror image. Replicas where we agree appear in neither.
  const iHave: Record<string, number> = {};
  const theyHave: Record<string, number> = {};
  for (const r of replicasOf(mine, theirs)) {
    const m = svGet(mine, r);
    const t = svGet(theirs, r);
    if (m > t) iHave[r] = m;
    else if (t > m) theyHave[r] = t;
  }
  return { iHave: Object.freeze(iHave) as StateVector, theyHave: Object.freeze(theyHave) as StateVector };
}

export function svEqual(a: StateVector, b: StateVector): boolean {
  // A missing replica and a replica at 0 mean the same thing: nothing held.
  for (const r of replicasOf(a, b)) if (svGet(a, r) !== svGet(b, r)) return false;
  return true;
}

/** Pointwise maximum: the state vector of a replica that holds everything either holds. Listed in LLD §1.1 for stateVector.ts; used by the Inspector and by tests. */
export function svMerge(a: StateVector, b: StateVector): StateVector {
  const out: Record<string, number> = {};
  for (const r of replicasOf(a, b)) {
    const n = Math.max(svGet(a, r), svGet(b, r));
    if (n > 0) out[r] = n;
  }
  return Object.freeze(out) as StateVector;
}

/** ops that `mine` holds and `theirs` lacks, in per-replica seq order. This is the catch-up payload; it is why the whole doc is never re-sent. */
export function opsSince(mine: Doc, theirs: StateVector, log: OpLog): readonly Op[] {
  const out: Op[] = [];
  const { iHave } = svDiff(mine.sv, theirs);
  for (const r of Object.keys(iHave).sort() as ReplicaId[]) {
    out.push(...log.get(r, svGet(theirs, r) + 1, svGet(iHave, r)));
  }
  return out;
}
