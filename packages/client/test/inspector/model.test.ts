// model.test.ts — the Sync Inspector's footer is computed from live facts, not hand-set (03-UI
// §4.5): equal state vectors read `A ≡ B ✓ converged`; a gap reads `A ≠ B · N in flight` with the
// honest per-replica op count; a latched divergence reads `A ≠ B · hashes differ`. Lanes are this
// device first, then peers by id, each with its state-vector chips and hash; an idle peer's lane is
// stale, and a diverged peer's lane is flagged.

import { describe, expect, it } from 'vitest';
import type { ReplicaId, StateVector } from '@weft/crdt';
import type { PresenceState } from '@weft/protocol';
import { AVATAR_IDLE_MS } from '../../src/presence/constants.ts';
import { emptyPeers, upsertPeer, type PeerTable } from '../../src/presence/awareness.ts';
import { noDivergence, observeDivergence } from '../../src/inspector/divergence.ts';
import { inspectorModel, type SelfLane } from '../../src/inspector/model.ts';

const A = 'bcdefghijklmn' as ReplicaId;
const B = 'cdefghijklmno' as ReplicaId;
const sv = (over: Record<string, number>): StateVector => over as StateVector;
const HASH = 'a'.repeat(64);
const self: SelfLane = { replica: A, name: 'Me', color: 0, sv: sv({ [A]: 3, [B]: 2 }), hash: HASH };
const peerState = (over: Partial<PresenceState>): PresenceState => ({ name: 'Mara', color: 1, ...over });
const tableWith = (s: PresenceState, at = 1_000): PeerTable => upsertPeer(emptyPeers, B, s, at);

describe('inspectorModel footer', () => {
  it('reads converged when the peer holds an equal state vector', () => {
    const m = inspectorModel(self, tableWith(peerState({ sv: sv({ [A]: 3, [B]: 2 }), hash: HASH })), noDivergence, 1_000);
    expect(m.footer).toEqual({ kind: 'ok', text: 'A ≡ B ✓ converged' });
  });

  it('reads N in flight with the honest per-replica op gap', () => {
    const m = inspectorModel(self, tableWith(peerState({ sv: sv({ [A]: 1, [B]: 2 }) })), noDivergence, 1_000); // A: |3-1| = 2
    expect(m.footer).toEqual({ kind: 'sync', text: 'A ≠ B · 2 in flight' });
  });

  it('reads hashes differ when a divergence is latched', () => {
    const latched = observeDivergence(noDivergence, [{ replica: B, peerHash: 'b'.repeat(64), mine: HASH }]);
    const m = inspectorModel(self, tableWith(peerState({ sv: sv({ [A]: 3, [B]: 2 }), hash: 'b'.repeat(64) })), latched, 1_000);
    expect(m.footer).toEqual({ kind: 'bad', text: 'A ≠ B · hashes differ' });
    expect(m.lanes.find((l) => l.replica === B)?.diverged).toBe(true);
  });
});

describe('inspectorModel lanes', () => {
  it('puts this device first with its own chips, then the peer, and marks an idle peer stale', () => {
    const m = inspectorModel(self, tableWith(peerState({ sv: sv({ [A]: 3, [B]: 2 }) }), 0), noDivergence, AVATAR_IDLE_MS);
    expect(m.lanes.map((l) => l.replica)).toEqual([A, B]);
    expect(m.lanes[0]?.self).toBe(true);
    expect(m.lanes[0]?.chips).toEqual([{ replica: A, seq: 3 }, { replica: B, seq: 2 }]);
    expect(m.lanes[0]?.hash).toBe(HASH);
    expect(m.lanes[1]?.stale).toBe(true);
  });

  it('shows an empty chip list and a null hash for a peer that has not published a state vector', () => {
    const m = inspectorModel(self, tableWith(peerState({})), noDivergence, 1_000);
    expect(m.lanes[1]?.chips).toEqual([]);
    expect(m.lanes[1]?.hash).toBe(null);
  });
});
