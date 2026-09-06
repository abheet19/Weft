// divergence.test.ts — the I13 tripwire (LLD §3 I13, §8 S5). A peer whose received hash differs
// from ours AT AN EQUAL STATE VECTOR is a genuine divergence and latches; a peer that is merely
// behind (unequal SVs, the in-flight case) does not trip the wire, even though its hash differs. The
// latch names the peer, only ever grows, and clears solely on an explicit dismissal — the runner's
// `dismissDivergence`. With no hash of our own yet there is nothing to compare and nothing trips.

import { describe, expect, it } from 'vitest';
import type { ReplicaId, StateVector } from '@weft/crdt';
import type { PresenceState } from '@weft/protocol';
import { emptyPeers, upsertPeer, type PeerTable } from '../../src/presence/awareness.ts';
import { divergences, isDiverged, noDivergence, observeDivergence } from '../../src/inspector/divergence.ts';

const A = 'bcdefghijklmn' as ReplicaId;
const B = 'cdefghijklmno' as ReplicaId;
const C = 'defghijklmnop' as ReplicaId;
const sv = (over: Record<string, number>): StateVector => over as StateVector;
const GOOD = 'a'.repeat(64);
const BAD = 'b'.repeat(64);

function tableWith(entries: readonly [ReplicaId, PresenceState][]): PeerTable {
  return entries.reduce((t, [id, s]) => upsertPeer(t, id, s, 1_000), emptyPeers);
}
const peer = (hash: string, s: StateVector): PresenceState => ({ name: 'Mara', color: 1, hash, sv: s });

describe('divergences', () => {
  it('flags a peer whose hash differs while its state vector equals ours', () => {
    const table = tableWith([[B, peer(BAD, sv({ [A]: 2, [B]: 2 }))]]);
    const found = divergences(table, sv({ [A]: 2, [B]: 2 }), GOOD);
    expect(found).toEqual([{ replica: B, peerHash: BAD, mine: GOOD }]);
  });

  it('does NOT flag an in-flight mismatch — a differing hash at a different state vector (a peer simply behind)', () => {
    const table = tableWith([[B, peer(BAD, sv({ [A]: 2, [B]: 1 }))]]);
    expect(divergences(table, sv({ [A]: 2, [B]: 2 }), GOOD)).toEqual([]);
  });

  it('does not flag a peer whose hash matches ours at an equal state vector', () => {
    const table = tableWith([[B, peer(GOOD, sv({ [A]: 2, [B]: 2 }))]]);
    expect(divergences(table, sv({ [A]: 2, [B]: 2 }), GOOD)).toEqual([]);
  });

  it('trips nothing until we have computed our own hash', () => {
    const table = tableWith([[B, peer(BAD, sv({ [A]: 2, [B]: 2 }))]]);
    expect(divergences(table, sv({ [A]: 2, [B]: 2 }), null)).toEqual([]);
  });
});

describe('observeDivergence — the latch', () => {
  it('latches a divergence and keeps it after the peer leaves, until an explicit dismissal', () => {
    const first = observeDivergence(noDivergence, [{ replica: B, peerHash: BAD, mine: GOOD }]);
    expect(isDiverged(first)).toBe(true);
    expect(first.get(B)).toEqual({ peerHash: BAD, mine: GOOD });
    // The peer is gone (no divergences found now), but the alarm stays.
    const stillOn = observeDivergence(first, []);
    expect(stillOn).toBe(first);
    expect(isDiverged(stillOn)).toBe(true);
    // Only the explicit dismissal (noDivergence) clears it.
    expect(isDiverged(noDivergence)).toBe(false);
  });

  it('returns the same reference when nothing is new but grows for a new peer', () => {
    const one = observeDivergence(noDivergence, [{ replica: B, peerHash: BAD, mine: GOOD }]);
    expect(observeDivergence(one, [{ replica: B, peerHash: 'c'.repeat(64), mine: GOOD }])).toBe(one); // B already latched: first hashes kept
    const two = observeDivergence(one, [{ replica: C, peerHash: BAD, mine: GOOD }]);
    expect([...two.keys()].sort()).toEqual([B, C].sort());
  });
});
