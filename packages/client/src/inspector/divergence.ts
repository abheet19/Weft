// divergence.ts — the I13 tripwire as PURE logic (LLD §3 I13, §8 S5). Two replicas that hold the
// same operations (equal state vectors, nothing pending) MUST hold the same document (I1); if a
// peer's published hash differs from ours while its state vector equals ours, the CRDT is wrong or
// the peer is lying, and either way the user must be told and must not be able to wave it away. The
// equal-SV guard is what keeps an ordinary in-flight lag — a peer that is simply behind — from
// tripping the wire: a real disagreement, not a race. The tripwire is PER PEER (it names who), and
// it LATCHES: `observe` only ever adds, so a peer that publishes a bad hash and then leaves does not
// clear the alarm — only an explicit `dismiss` does (I13 "cannot be dismissed without an explicit
// action"). This file reads no clock and mutates nothing it is given.

import { svEqual, type ReplicaId, type StateVector } from '@weft/crdt';
import type { PeerTable } from '../presence/awareness.ts';

/** One replica disagreeing with us at an equal state vector: its hash, and ours, so the report can show both. */
export interface Divergence {
  readonly replica: ReplicaId;
  readonly peerHash: string;
  readonly mine: string;
}

/**
 * The peers whose received hash differs from ours at an equal state vector. `myHash` is null until we
 * have computed our own (after a `quiet` at our current sv); with no hash of our own there is nothing
 * to compare, so nothing trips. A peer without a hash, or with a hash computed for a different sv
 * (`peer.state.sv`), is not yet comparable and is skipped — that is the in-flight case, not a fault.
 */
export function divergences(table: PeerTable, mySv: StateVector, myHash: string | null): readonly Divergence[] {
  if (myHash === null) return [];
  const out: Divergence[] = [];
  for (const [replica, peer] of table) {
    const { hash, sv } = peer.state;
    if (hash === undefined || sv === undefined) continue;
    if (svEqual(sv, mySv) && hash !== myHash) out.push({ replica, peerHash: hash, mine: myHash });
  }
  return out;
}

/** The latched set of diverged peers: which replica disagreed and the two hashes. Empty means no tripwire. */
export type DivergedState = ReadonlyMap<ReplicaId, { readonly peerHash: string; readonly mine: string }>;

/** No divergence — a shared constant so the runner and the UI start from one value. */
export const noDivergence: DivergedState = new Map();

/** Fold newly observed divergences into the latch. It only grows: a peer already flagged keeps its first-seen hashes; a new peer is added. Returns the same reference when nothing is new, so React can skip a render. */
export function observeDivergence(prev: DivergedState, found: readonly Divergence[]): DivergedState {
  let next: Map<ReplicaId, { peerHash: string; mine: string }> | null = null;
  for (const d of found) {
    if (prev.has(d.replica)) continue;
    next ??= new Map(prev);
    next.set(d.replica, { peerHash: d.peerHash, mine: d.mine });
  }
  return next ?? prev;
}

/** True when at least one peer is latched as diverged — the alarm is on. */
export function isDiverged(state: DivergedState): boolean {
  return state.size > 0;
}
