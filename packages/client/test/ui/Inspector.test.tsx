// @vitest-environment jsdom
// Inspector.test.tsx — the Sync Inspector's footer reads the three states of 03-UI §4.5 from live
// facts: converged, N in flight, and the divergence tripwire's "hashes differ". Rendered with
// react-dom into jsdom over a stub session (the footer and lanes are pure reads; the chaos buttons'
// handlers are not exercised here). Complements model.test.ts, which pins the pure computation.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReplicaId, StateVector } from '@weft/crdt';
import type { PresenceState } from '@weft/protocol';
import { emptyPeers, upsertPeer, type PeerTable } from '../../src/presence/awareness.ts';
import { noDivergence, observeDivergence, type DivergedState } from '../../src/inspector/divergence.ts';
import type { Session } from '../../src/session/open.ts';
import type { RunnerSnapshot } from '../../src/session/runner.ts';
import { initialSession } from '../../src/session/machine.ts';
import { Inspector } from '../../src/ui/Inspector.tsx';

const A = 'bcdefghijklmn' as ReplicaId;
const B = 'cdefghijklmno' as ReplicaId;
const self = { replica: A, name: 'me', color: 0 };
const sv = (o: Record<string, number>): StateVector => o as StateVector;
const HASH = 'a'.repeat(64);
const session = { runner: { setDelay: () => {}, dropNext: () => {}, receivePresence: () => {} }, setUserOffline: () => {} } as unknown as Session;

function snapshotOf(peers: PeerTable, diverged: DivergedState, hash: string | null): RunnerSnapshot {
  return { session: initialSession, sv: sv({ [A]: 3, [B]: 2 }), pending: 0, hash, peers, diverged, lastQuiet: null, ignored: 0, supported: null, historyLength: 0, canUndo: false, canRedo: false };
}
const peer = (over: Partial<PresenceState>): PeerTable => upsertPeer(emptyPeers, B, { name: 'Mara', color: 1, ...over }, 1_000);

describe('Inspector footer', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });
  function render(snapshot: RunnerSnapshot): HTMLElement {
    host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
    act(() => root!.render(<Inspector self={self} snapshot={snapshot} session={session} userOffline={false} />));
    return host;
  }
  const footer = (el: HTMLElement): string => el.querySelector('[data-testid="inspector-footer"] span')?.textContent ?? '';

  it('reads converged when the peer holds an equal state vector', () => {
    expect(footer(render(snapshotOf(peer({ sv: sv({ [A]: 3, [B]: 2 }), hash: HASH }), noDivergence, HASH)))).toBe('A ≡ B ✓ converged');
  });

  it('reads N in flight when the peer is behind', () => {
    expect(footer(render(snapshotOf(peer({ sv: sv({ [A]: 1, [B]: 2 }) }), noDivergence, HASH)))).toBe('A ≠ B · 2 in flight');
  });

  it('reads hashes differ when a divergence is latched', () => {
    const latched = observeDivergence(noDivergence, [{ replica: B, peerHash: 'b'.repeat(64), mine: HASH }]);
    const el = render(snapshotOf(peer({ sv: sv({ [A]: 3, [B]: 2 }), hash: 'b'.repeat(64) }), latched, HASH));
    expect(footer(el)).toBe('A ≠ B · hashes differ');
    expect(el.querySelector('.lane-hash.bad')).not.toBeNull();
  });
});
