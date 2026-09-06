// presence.test.ts — the runner's S5 behaviour over the REAL server: this replica broadcasts its
// cursor as item anchors (throttled, separate from ops) and a peer sees it; the chaos controls the
// demo and tests share actually work (Drop next N opens a seq gap the client repairs by re-hello;
// Delay holds outbound frames and the peer still converges); the awareness table expires a peer that
// goes quiet past its TTL and clears to empty on disconnect; and the divergence tripwire latches on a
// peer that disagrees at an equal state vector and clears only on the explicit dismissal (I13).
// Presence timing is injected in milliseconds so the TTL and heartbeat are testable in a fast run.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer } from '@weft/server';
import { buildIndex, localInsert, visibleItems, type Doc, type ReplicaId } from '@weft/crdt';
import type { PresenceState } from '@weft/protocol';
import { anchorFromVisible } from '../../src/binding/positions.ts';
import { memoryStore } from '../../src/store/memoryStore.ts';
import { startRunner, type Runner } from '../../src/session/runner.ts';
import { until } from '../headlessHelpers.ts';

const R = { a: 'bcdefghijklmn' as ReplicaId, b: 'cdefghijklmno' as ReplicaId };
const DOC = 'doc-presence-01';
const FAST = { heartbeatMs: 40, sweepMs: 15, ttlMs: 120 };

let server: Awaited<ReturnType<typeof startServer>>;
let dataDir: string;
const runners: Runner[] = [];

async function runner(me: ReplicaId, timing = FAST): Promise<Runner> {
  const r = await startRunner({ url: `ws://127.0.0.1:${server.port}`, doc: DOC, me, store: memoryStore(me), presence: { name: me.slice(0, 6), color: 1 }, presenceTiming: timing });
  runners.push(r);
  return r;
}

async function insert(r: Runner, from: number, text: string): Promise<void> {
  await r.local((doc, me, seq) => {
    const ops = [];
    let cur = doc;
    let at = from;
    for (const ch of text) {
      const step = localInsert(cur, me, seq + ops.length, at++, { kind: 'char', text: ch });
      ops.push(...step.ops);
      cur = step.doc;
    }
    return { ops, doc: cur };
  });
}

const text = (doc: Doc): string => visibleItems(doc).map((i) => (i.content.kind === 'char' ? i.content.text : '\n')).join('');
const live = (r: Runner): boolean => r.snapshot().session.s === 'live';

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'weft-presence-'));
  server = await startServer({ host: '127.0.0.1', port: 0, dataDir, limits: { QUIET_MS: 40 }, warn: () => undefined });
});

afterEach(async () => {
  await Promise.all(runners.splice(0).map((r) => r.close()));
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('cursor broadcast', () => {
  it('publishes the local caret as item anchors and a peer sees it', async () => {
    const a = await runner(R.a);
    const b = await runner(R.b);
    await until(() => live(a) && live(b), 'both live');
    await insert(a, 0, 'Hello');
    await until(() => text(b.doc) === 'Hello', 'b has the text');

    a.setCursor({ anchor: anchorFromVisible(buildIndex(a.doc), 3), head: anchorFromVisible(buildIndex(a.doc), 3) });
    await until(() => b.snapshot().peers.get(R.a)?.state.cursor !== undefined, "b sees a's cursor");
    const cursor = b.snapshot().peers.get(R.a)?.state.cursor;
    expect(cursor?.head.side).toBe('after');
    expect(cursor?.head.id).not.toBeNull();
  });
});

describe('chaos controls', () => {
  it('Drop next N opens a seq gap the client repairs by re-hello, and both still converge', async () => {
    const a = await runner(R.a);
    const b = await runner(R.b);
    await until(() => live(a) && live(b), 'both live');
    await insert(b, 0, 'base');
    await until(() => text(a.doc) === 'base', 'a has base');

    a.dropNext(1); // swallow b's next op frame → a is behind, no gap yet
    await insert(b, 4, 'X');
    await insert(b, 5, 'Y'); // the second frame reveals the gap → a re-hellos and catches up
    await until(() => text(a.doc) === 'baseXY', () => `a repaired via re-hello (a=${JSON.stringify(text(a.doc))})`);
    expect(a.snapshot().ignored).toBeGreaterThan(0); // the dropped frame was counted, never hidden
  });

  it('Delay holds outbound frames but the peer still converges', async () => {
    const a = await runner(R.a);
    const b = await runner(R.b);
    await until(() => live(a) && live(b), 'both live');
    a.setDelay(60);
    await insert(a, 0, 'Zed');
    await until(() => text(b.doc) === 'Zed', 'b got the delayed ops');
    a.setDelay(0);
  });
});

describe('awareness lifecycle', () => {
  it('expires a peer that goes quiet past its TTL', async () => {
    const a = await runner(R.a, { heartbeatMs: 100_000, sweepMs: 15, ttlMs: 80 });
    await until(() => live(a), 'a live');
    a.receivePresence(R.b, { name: 'ghost', color: 2 } as PresenceState);
    expect(a.snapshot().peers.get(R.b)).toBeDefined();
    await until(() => a.snapshot().peers.get(R.b) === undefined, 'the quiet peer expired', 2_000);
  });

  it('clears the peer table to empty on disconnect (the UI then reads "unknown")', async () => {
    const a = await runner(R.a);
    await until(() => live(a), 'a live');
    a.receivePresence(R.b, { name: 'Mara', color: 1 } as PresenceState);
    expect(a.snapshot().peers.size).toBe(1);
    a.dispatch({ e: 'USER_OFFLINE' });
    expect(a.snapshot().peers.size).toBe(0);
  });
});

describe('divergence tripwire (I13)', () => {
  it('latches on a peer that disagrees at an equal state vector, and clears only on the explicit dismissal', async () => {
    const a = await runner(R.a);
    await until(() => live(a), 'a live');
    await insert(a, 0, 'converge');
    await until(() => a.snapshot().hash !== null, 'a has computed its own hash after quiet');

    const mine = a.snapshot().hash as string;
    const bad = (mine[0] === 'f' ? '0' : 'f') + mine.slice(1);

    // A peer merely behind (an in-flight mismatch, unequal sv) does not trip, even with a differing hash.
    a.receivePresence('defghijklmnop' as ReplicaId, { name: 'behind', color: 3, hash: bad, sv: { ...a.snapshot().sv, [R.a]: 999 } });
    expect(a.snapshot().diverged.size).toBe(0);

    // A peer disagreeing at an equal sv latches, naming the peer and both hashes.
    a.receivePresence(R.b, { name: 'phantom', color: 2, hash: bad, sv: a.snapshot().sv });
    expect(a.snapshot().diverged.get(R.b)).toEqual({ peerHash: bad, mine });

    // Only the explicit dismissal clears it.
    a.receivePresence(R.b, null); // the phantom leaves, so a later recompute cannot re-latch it
    a.dismissDivergence();
    expect(a.snapshot().diverged.size).toBe(0);
  });
});

describe('display name (⌘K Set my name)', () => {
  it('re-broadcasts the changed name at once and a peer sees it', async () => {
    const a = await runner(R.a);
    const b = await runner(R.b);
    await until(() => live(a) && live(b), 'both live');
    // A publishes its default name (its short replica id) on going live; B sees it.
    await until(() => b.snapshot().peers.get(R.a)?.state.name === R.a.slice(0, 6), 'b sees A default name');
    a.setName('Mara');
    await until(() => b.snapshot().peers.get(R.a)?.state.name === 'Mara', 'b sees the new name');
  });
});
