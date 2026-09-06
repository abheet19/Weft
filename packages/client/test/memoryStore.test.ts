// memoryStore.test.ts — the Store contract as the runner relies on it: `load` after `putOps`
// returns every op (property, against a direct replay), `compact` then `load` is the same
// document (D4), own ops — acknowledged or not — survive compaction (E38: this device is the only
// place a server that lost its log can be refilled from), and `unacked` is exactly the own ops
// above the acknowledged seq. The "storage unavailable" fallback is also the honest one:
// `persisted()` answers false.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalString, emptyDoc, localInsert, pendingCount, svEqual, visibleItems, type Doc, type Op, type ReplicaId, type StateVector } from '@weft/crdt';
import { memoryStore } from '../src/store/memoryStore.ts';

const A = 'bcdefghijklmn' as ReplicaId;
const B = 'cdefghijklmno' as ReplicaId;
const numRuns = process.env['CI'] ? 2_000 : 200;

/** Type `text` at `index` on `doc` as `me`, continuing from the doc's own seq for `me`. */
function type(doc: Doc, me: ReplicaId, index: number, text: string): { ops: Op[]; doc: Doc } {
  const ops: Op[] = [];
  let cur = doc;
  let at = index;
  for (const ch of text) {
    const seq = (Object.hasOwn(cur.sv, me) ? (cur.sv as Readonly<Record<string, number>>)[me] ?? 0 : 0) + 1;
    const step = localInsert(cur, me, seq, at++, { kind: 'char', text: ch });
    ops.push(...step.ops);
    cur = step.doc;
  }
  return { ops, doc: cur };
}

const text = (doc: Doc): string => visibleItems(doc).map((i) => (i.content.kind === 'char' ? i.content.text : '▮')).join('');

describe('load', () => {
  it('answers null for a store nothing was written to, so "fresh" is distinguishable from "empty"', async () => {
    expect(await memoryStore(A).load()).toBeNull();
  });

  it('rebuilds the document from the ops it holds and reports the identity and the acknowledged vector', async () => {
    const store = memoryStore(A);
    const { ops } = type(emptyDoc(), A, 0, 'hey');
    await store.putOps(ops);
    await store.markAcked({ [A]: 2 } as StateVector);
    const loaded = await store.load();
    expect(loaded?.me).toBe(A);
    expect(loaded?.acked).toEqual({ [A]: 2 });
    expect(text(loaded?.doc as Doc)).toBe('hey');
  });

  it('applies ops whose parent arrives from another replica later in the scan (the pending buffer drains them)', async () => {
    const store = memoryStore(B);
    const a = type(emptyDoc(), A, 0, 'a');
    const b = type(a.doc, B, 1, 'b'); // b's char hangs under a's
    await store.putOps(b.ops); // stored first, keyed under B
    await store.putOps(a.ops);
    expect(text((await store.load())?.doc as Doc)).toBe('ab');
  });

  it('property: load after putOps in random chunks equals a direct replay', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 30, unit: fc.constantFrom('a', 'b', 'c') }), fc.integer({ min: 1, max: 7 }), async (s, chunk) => {
        const store = memoryStore(A);
        const { ops, doc } = type(emptyDoc(), A, 0, s);
        for (let i = 0; i < ops.length; i += chunk) await store.putOps(ops.slice(i, i + chunk));
        const loaded = await store.load();
        expect(canonicalString(loaded?.doc as Doc)).toBe(canonicalString(doc));
        expect(svEqual((loaded?.doc as Doc).sv, doc.sv)).toBe(true);
      }),
      { numRuns },
    );
  });
});

describe('unacked and opLog', () => {
  it('unacked is the own ops above the acknowledged seq, in seq order; acks only ever move forward', async () => {
    const store = memoryStore(A);
    const mine = type(emptyDoc(), A, 0, 'abcd');
    const theirs = type(mine.doc, B, 4, 'xy');
    await store.putOps([...theirs.ops, ...mine.ops]);
    expect((await store.unacked()).map((op) => op.id.seq)).toEqual([1, 2, 3, 4]);
    await store.markAcked({ [A]: 2, [B]: 2 } as StateVector);
    expect((await store.unacked()).map((op) => op.id.seq)).toEqual([3, 4]);
    await store.markAcked({ [A]: 1 } as StateVector);
    expect((await store.unacked()).map((op) => op.id.seq)).toEqual([3, 4]);
  });

  it('opLog.get returns the inclusive seq range that is held, for any replica', async () => {
    const store = memoryStore(A);
    const { ops } = type(emptyDoc(), A, 0, 'abcde');
    await store.putOps(ops);
    expect(store.opLog().get(A, 2, 4).map((op) => op.id.seq)).toEqual([2, 3, 4]);
    expect(store.opLog().get(A, 5, 99).map((op) => op.id.seq)).toEqual([5]);
    expect(store.opLog().get(B, 1, 9)).toEqual([]);
  });
});

describe('compact ⟨D4⟩', () => {
  it('E38: load after compact is the same document, foreign ops are pruned, and EVERY own op is kept — acknowledged ones too, they are the only copy the server can be refilled from', async () => {
    const store = memoryStore(A);
    const mine = type(emptyDoc(), A, 0, 'abc');
    const theirs = type(mine.doc, B, 3, 'xyz');
    await store.putOps([...mine.ops, ...theirs.ops]);
    await store.markAcked({ [A]: 1 } as StateVector);
    const before = (await store.load())?.doc as Doc;
    await store.compact(before);
    expect(store.opLog().get(B, 1, 9)).toEqual([]);
    expect(store.opLog().get(A, 1, 9).map((op) => op.id.seq)).toEqual([1, 2, 3]);
    expect((await store.unacked()).map((op) => op.id.seq)).toEqual([2, 3]);
    const after = (await store.load())?.doc as Doc;
    expect(canonicalString(after)).toBe(canonicalString(before));
    expect(svEqual(after.sv, before.sv)).toBe(true);
    // Life goes on after compaction: new ops apply on top of the snapshot.
    const more = type(after, A, 6, '!');
    await store.putOps(more.ops);
    expect(text((await store.load())?.doc as Doc)).toBe('abcxyz!');
  });

  it('a parked op survives compaction inside the snapshot and drains when its dependency finally arrives', async () => {
    const store = memoryStore(B);
    const a = type(emptyDoc(), A, 0, 'a');
    const orphan = type(a.doc, B, 1, 'b').ops; // hangs under a's char, which the store does not hold yet
    await store.putOps(orphan);
    const loaded = (await store.load())?.doc as Doc;
    expect(pendingCount(loaded)).toBe(1);
    await store.compact(loaded);
    expect(store.opLog().get(B, 1, 9)).toHaveLength(1); // own and unacknowledged: still in the log too
    const reloaded = (await store.load())?.doc as Doc;
    expect(pendingCount(reloaded)).toBe(1);
    expect(text(reloaded)).toBe('');
    await store.putOps(a.ops);
    expect(text((await store.load())?.doc as Doc)).toBe('ab');
  });

  it('persisted() is false: memory is never durable and the UI must say so', async () => {
    expect(await memoryStore(A).persisted()).toBe(false);
  });
});
