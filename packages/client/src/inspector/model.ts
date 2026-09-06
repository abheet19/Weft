// model.ts — the Sync Inspector's contents as a PURE view model (03-UI §4.5), computed from live
// facts only: this replica's state vector and content hash, the peer table, and the latched
// divergence set. One lane per replica (this device first), each with its state-vector chips
// (`a:412 b:97`) and content hash; a footer that reads, from those same facts, `A ≡ B ✓ converged`
// / `A ≠ B · N in flight` / `A ≠ B · hashes differ`. The footer is the demo's proof line, so it is
// derived here and asserted by a test, never hand-set by the component. "In flight" is the honest
// count of the per-replica state-vector gap to the peers we can see; "hashes differ" fires only from
// the latch (equal SVs already checked, I13). It reads no clock beyond the `now` passed for the idle
// (stale) flag and mutates nothing.

import { svGet, type ReplicaId, type StateVector } from '@weft/crdt';
import { AVATAR_IDLE_MS } from '../presence/constants.ts';
import type { PeerTable } from '../presence/awareness.ts';
import { isDiverged, type DivergedState } from './divergence.ts';

/** One `seq@replica` / `replica:seq` chip: a replica and how many of its ops the lane holds. */
interface LaneChip {
  readonly replica: ReplicaId;
  readonly seq: number;
}

/** One replica's row in the Inspector. */
export interface Lane {
  readonly replica: ReplicaId;
  readonly name: string;
  readonly color: number;
  readonly self: boolean;
  /** The lane's state vector as sorted chips; empty when a peer has not published one yet. */
  readonly chips: readonly LaneChip[];
  /** The full 64-hex content hash if the lane has published one, else null (in flight). */
  readonly hash: string | null;
  /** A peer idle past the avatar threshold; never true for this device's own lane. */
  readonly stale: boolean;
  /** This replica is latched as diverged from us — its hash is shown in the bad colour. */
  readonly diverged: boolean;
}

type FooterKind = 'ok' | 'sync' | 'bad';
interface Footer {
  readonly kind: FooterKind;
  readonly text: string;
}

export interface InspectorModel {
  readonly lanes: readonly Lane[];
  readonly footer: Footer;
}

export interface SelfLane {
  readonly replica: ReplicaId;
  readonly name: string;
  readonly color: number;
  readonly sv: StateVector;
  readonly hash: string | null;
}

function chipsOf(sv: StateVector): readonly LaneChip[] {
  return Object.entries(sv)
    .filter(([, seq]) => seq > 0)
    .map(([replica, seq]) => ({ replica: replica as ReplicaId, seq }))
    .sort((a, b) => (a.replica < b.replica ? -1 : a.replica > b.replica ? 1 : 0));
}

/** The per-replica absolute gap between two state vectors — how many ops one holds that the other does not, summed both ways. */
function svDistance(a: StateVector, b: StateVector): number {
  let sum = 0;
  for (const replica of new Set([...Object.keys(a), ...Object.keys(b)])) sum += Math.abs(svGet(a, replica) - svGet(b, replica));
  return sum;
}

/** The Inspector's lanes and footer. Lanes are this device first, then peers by replica id. */
export function inspectorModel(self: SelfLane, table: PeerTable, diverged: DivergedState, now: number): InspectorModel {
  const lanes: Lane[] = [{ replica: self.replica, name: self.name, color: self.color, self: true, chips: chipsOf(self.sv), hash: self.hash, stale: false, diverged: false }];
  let inFlight = 0;
  for (const [replica, peer] of [...table.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const sv = peer.state.sv;
    if (sv !== undefined) inFlight += svDistance(self.sv, sv);
    lanes.push({
      replica,
      name: peer.state.name,
      color: peer.state.color,
      self: false,
      chips: sv === undefined ? [] : chipsOf(sv),
      hash: peer.state.hash ?? null,
      stale: now - peer.movedAt >= AVATAR_IDLE_MS,
      diverged: diverged.has(replica),
    });
  }
  return { lanes, footer: footerOf(diverged, inFlight) };
}

function footerOf(diverged: DivergedState, inFlight: number): Footer {
  if (isDiverged(diverged)) return { kind: 'bad', text: 'A ≠ B · hashes differ' };
  if (inFlight > 0) return { kind: 'sync', text: `A ≠ B · ${inFlight} in flight` };
  return { kind: 'ok', text: 'A ≡ B ✓ converged' };
}
