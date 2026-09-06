// awareness.test.ts — the pure peer table (LLD §6.2 client/presence): peers expire at exactly the
// TTL given `now`; a heartbeat refreshes the TTL without resetting the idle fade (so a still-but-
// present peer keeps its avatar and its caret fades honestly); a clean goodbye removes a peer; and
// the honest-degradation rule is a pure value — a disconnect is "unknown", never the "alone" of an
// empty table with a live socket. `now` is always supplied; nothing here reads a clock.

import { describe, expect, it } from 'vitest';
import type { ReplicaId } from '@weft/crdt';
import type { ItemAnchor, PresenceState } from '@weft/protocol';
import { AVATAR_IDLE_MS, CARET_IDLE_MS, PRESENCE_FLAG_MS } from '../../src/presence/constants.ts';
import { caretViews, emptyPeers, expirePeers, initials, presenceView, upsertPeer } from '../../src/presence/awareness.ts';

const A = 'bcdefghijklmn' as ReplicaId;
const B = 'cdefghijklmno' as ReplicaId;
const TTL = 30_000;
const anchor = (seq: number): ItemAnchor => ({ id: { replica: A, seq }, side: 'after' });
const state = (over: Partial<PresenceState> = {}): PresenceState => ({ name: 'Mara', color: 1, ...over });
const withCursor = (seq: number): PresenceState => state({ cursor: { anchor: anchor(seq), head: anchor(seq) } });

describe('expirePeers', () => {
  it('expires a peer at exactly the TTL measured from its last frame', () => {
    const table = upsertPeer(emptyPeers, A, state(), 1_000);
    expect(expirePeers(table, 1_000 + TTL - 1, TTL).has(A)).toBe(true);
    expect(expirePeers(table, 1_000 + TTL, TTL).has(A)).toBe(false);
  });

  it('returns the same table reference when nothing expired, so the runner can skip a redraw', () => {
    const table = upsertPeer(emptyPeers, A, state(), 1_000);
    expect(expirePeers(table, 1_500, TTL)).toBe(table);
  });
});

describe('upsertPeer', () => {
  it('records a peer and removes it on a null (clean goodbye)', () => {
    const table = upsertPeer(emptyPeers, A, state(), 100);
    expect(table.get(A)?.state.name).toBe('Mara');
    expect(upsertPeer(table, A, null, 200).has(A)).toBe(false);
  });

  it('advances seenAt on a heartbeat but keeps movedAt when the cursor is unchanged', () => {
    const first = upsertPeer(emptyPeers, A, withCursor(3), 1_000);
    const beat = upsertPeer(first, A, withCursor(3), 20_000); // same cursor, later frame
    expect(beat.get(A)?.seenAt).toBe(20_000);
    expect(beat.get(A)?.movedAt).toBe(1_000);
  });

  it('advances movedAt when the cursor moves', () => {
    const first = upsertPeer(emptyPeers, A, withCursor(3), 1_000);
    const moved = upsertPeer(first, A, withCursor(9), 5_000);
    expect(moved.get(A)?.movedAt).toBe(5_000);
  });
});

describe('presenceView — honest degradation', () => {
  it('is "unknown" while disconnected even if the table still holds a peer, never "alone"', () => {
    const table = upsertPeer(emptyPeers, A, state(), 1_000);
    expect(presenceView(table, false, 1_000)).toEqual({ kind: 'unknown' });
  });

  it('is "alone" only when connected with an empty table', () => {
    expect(presenceView(emptyPeers, true, 0)).toEqual({ kind: 'alone' });
  });

  it('lists peers when connected, fading one idle past the avatar threshold', () => {
    let table = upsertPeer(emptyPeers, A, withCursor(3), 0);
    table = upsertPeer(table, A, withCursor(3), AVATAR_IDLE_MS); // heartbeat keeps A alive but idle (movedAt stays 0)
    table = upsertPeer(table, B, state({ name: 'Tomas', color: 6 }), AVATAR_IDLE_MS); // B just arrived: fresh
    const view = presenceView(table, true, AVATAR_IDLE_MS);
    expect(view.kind).toBe('peers');
    if (view.kind !== 'peers') throw new Error('expected peers');
    expect(view.peers.map((p) => p.replica)).toEqual([A, B]); // sorted by id
    expect(view.peers.find((p) => p.replica === A)?.idle).toBe(true);
    expect(view.peers.find((p) => p.replica === B)?.idle).toBe(false);
  });
});

describe('caretViews', () => {
  it('draws a caret only for a peer with a cursor, flagged right after a move and faded after 30 s idle', () => {
    let table = upsertPeer(emptyPeers, A, withCursor(3), 1_000);
    table = upsertPeer(table, B, state(), 1_000); // no cursor: an avatar, but no caret
    const fresh = caretViews(table, 1_000 + PRESENCE_FLAG_MS - 1);
    expect(fresh.map((c) => c.replica)).toEqual([A]);
    expect(fresh[0]?.flag).toBe(true);
    expect(fresh[0]?.idle).toBe(false);
    // A heartbeat much later keeps the peer alive but its caret fades (movedAt did not advance).
    const beat = upsertPeer(table, A, withCursor(3), 1_000 + CARET_IDLE_MS);
    const stale = caretViews(beat, 1_000 + CARET_IDLE_MS);
    expect(stale[0]?.flag).toBe(false);
    expect(stale[0]?.idle).toBe(true);
  });
});

describe('initials', () => {
  it('takes one letter from each of the first two words, or two from a single word', () => {
    expect(initials('Mara')).toBe('MA');
    expect(initials('Mara Vance')).toBe('MV');
    expect(initials('  ')).toBe('?');
  });
});
