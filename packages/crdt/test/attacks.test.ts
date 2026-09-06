// attacks.test.ts — the adversarial pass of LLD §8 for S1, each attack as a test named `attack: …`.
// A hostile reviewer's job is to break the tree, the seq rule, the ordering, or the snapshot
// decoder. Expected defences: `rejected` with a reason and an untouched doc; a tombstone parent
// ACCEPTED (that is correct Fugue); deterministic order for ids differing in one character;
// prototype-polluting snapshots refused; 100k inserts + 100k deletes + one insert at 0 within
// budget and with a bounded pending buffer; a 100k sibling flood (review P7) stays linear-ish.
import { describe, expect, it } from 'vitest';
import {
  apply,
  buildIndex,
  canonicalString,
  decodeSnapshot,
  emptyDoc,
  encodeSnapshot,
  idKey,
  localInsert,
  pendingCount,
  ROOT,
  svEqual,
  svGet,
  visibleItems,
  type Op,
  type ReplicaId,
  type Snapshot,
} from '../src/index.ts';
import { block, char, del, fmt, id, ins, R, replay, Replica, text } from './helpers.ts';

describe('attacks from LLD §8, slice S1', () => {
  it('attack: an op whose parent is itself is rejected SELF_PARENT and the doc is the same object', () => {
    const doc = emptyDoc();
    const r = apply(doc, ins(id(R.a, 1), id(R.a, 1), 'R'));
    expect(r).toMatchObject({ kind: 'rejected', reason: 'SELF_PARENT' });
    expect(r.doc).toBe(doc);
  });

  it('attack: an insert whose parent is a tombstone is ACCEPTED, and both replicas place it identically', () => {
    const a = new Replica(R.a);
    a.type(0, 'ab');
    const b = new Replica(R.b);
    b.receiveAll(a.log);
    a.delete(1, 2); // "b" becomes a tombstone on a
    b.insert(2, char('x')); // b still sees "ab" and types after b: parent is a:2, the item a just deleted
    expect(b.log.at(-1)).toMatchObject({ parent: id(R.a, 2), side: 'R' });
    const r = a.receive(b.log.at(-1) as Op);
    expect(r.kind).toBe('applied');
    b.receiveAll(a.log.slice(2));
    expect(text(a.doc)).toBe('ax');
    expect(text(b.doc)).toBe('ax');
  });

  it('attack: a parent on the L side of ROOT is rejected BAD_PARENT_SIDE', () => {
    const r = apply(emptyDoc(), ins(id(R.a, 1), ROOT.id, 'L'));
    expect(r).toMatchObject({ kind: 'rejected', reason: 'BAD_PARENT_SIDE' });
  });

  it('attack: a del of ROOT is rejected TARGET_IS_ROOT, and ROOT spelled with a string seq is not an id at all (MALFORMED)', () => {
    expect(apply(emptyDoc(), del(id(R.a, 1), ROOT.id))).toMatchObject({ kind: 'rejected', reason: 'TARGET_IS_ROOT' });
    const spoofed = { replica: ROOT.id.replica, seq: '0' as unknown as number };
    expect(apply(emptyDoc(), del(id(R.a, 1), spoofed))).toMatchObject({ kind: 'rejected', reason: 'MALFORMED' });
    expect(visibleItems(emptyDoc())).toEqual([]);
  });

  it('attack: an ins with seq 0, 2^53, a negative, a fraction, NaN or a string seq is rejected MALFORMED and consumes nothing', () => {
    const doc = emptyDoc();
    for (const seq of [0, 2 ** 53, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1' as unknown as number]) {
      const r = apply(doc, ins({ replica: R.a, seq }, ROOT.id, 'R'));
      expect(r).toMatchObject({ kind: 'rejected', reason: 'MALFORMED' });
      expect(r.doc).toBe(doc);
    }
    expect(svGet(doc.sv, R.a)).toBe(0);
  });

  it('attack: an op from a malformed replica id (wrong length, uppercase, "__proto__", "constructor") is rejected MALFORMED', () => {
    for (const replica of ['', 'abc', 'ABCDEFGHIJKLM', '__proto__', 'constructor', 'abcdefghijkl1']) {
      const r = apply(emptyDoc(), ins({ replica: replica as ReplicaId, seq: 1 }, ROOT.id, 'R'));
      expect(r).toMatchObject({ kind: 'rejected', reason: 'MALFORMED' });
      expect(Object.keys(r.doc.sv)).toEqual([]);
    }
  });

  it('attack: an op that reuses an already-held seq with different content is a duplicate and changes nothing (the server refuses it; the client must not diverge)', () => {
    const a = new Replica(R.a);
    a.type(0, 'a');
    const before = a.doc;
    const forged: Op = ins(id(R.a, 1), ROOT.id, 'R', char('Z'));
    expect(a.receive(forged).kind).toBe('duplicate');
    expect(a.doc).toBe(before);
    expect(text(a.doc)).toBe('a');
  });

  it('attack: an op whose seq jumps ahead by 1 000 is rejected SEQ_GAP and nothing is parked', () => {
    const a = new Replica(R.a);
    a.type(0, 'a');
    const r = a.receive(ins(id(R.b, 1000), id(R.a, 1), 'R'));
    expect(r).toMatchObject({ kind: 'rejected', reason: 'SEQ_GAP' });
    expect(pendingCount(a.doc)).toBe(0);
  });

  it('attack: a fmt, blk or ins carrying a mark name, block type, level or content shape outside the closed sets is rejected, so the doc always stays snapshot-able', () => {
    const a = new Replica(R.a);
    a.type(0, 'a');
    a.insert(1, block({ type: 'paragraph' }, R.a));
    const target = id(R.a, 1);
    const boundary = id(R.a, 2);
    const bad: Op[] = [
      { ...fmt(id(R.b, 1), [target], 'bold', true, 1), mark: '__proto__' as 'bold' },
      { ...fmt(id(R.b, 1), [target], 'bold', true, 1), mark: 'blink' as 'bold' },
      { ...fmt(id(R.b, 1), [target], 'textColor', true, 1), value: 9 as unknown as string },
      { ...fmt(id(R.b, 1), [target], 'bold', true, 1), active: 'yes' as unknown as boolean },
      { ...fmt(id(R.b, 1), [target], 'bold', true, Number.NaN) },
      { ...fmt(id(R.b, 1), [target], 'link', true, 1), href: 7 as unknown as string },
      { t: 'blk', id: id(R.b, 1), target: boundary, attrs: { type: 'table' as 'quote' }, lamport: 1 },
      { t: 'blk', id: id(R.b, 1), target: boundary, attrs: { type: 'bullet', level: 4 as 1 }, lamport: 1 },
      { t: 'blk', id: id(R.b, 1), target: boundary, attrs: { type: 'quote', extra: 1 } as unknown as { type: 'quote' }, lamport: 1 },
      { t: 'blk', id: id(R.b, 1), target: boundary, attrs: { type: 'quote' }, lamport: -1 },
      ins(id(R.b, 1), target, 'R', { kind: 'char', text: 5 as unknown as string }),
      ins(id(R.b, 1), target, 'R', { kind: 'block', attrs: { type: 'heading', level: 9 as 1 }, lamport: 0, replica: R.b }),
      ins(id(R.b, 1), target, 'R', { kind: 'block', attrs: { type: 'quote' }, lamport: 0, replica: 'nope' as ReplicaId }),
      ins(id(R.b, 1), target, 'R', { kind: 'img' } as unknown as { kind: 'char'; text: string }),
    ];
    for (const op of bad) {
      const r = a.receive(op);
      expect(r.kind, JSON.stringify(op)).toBe('rejected');
      expect(pendingCount(a.doc)).toBe(0);
    }
    expect(() => decodeSnapshot(JSON.parse(JSON.stringify(encodeSnapshot(a.doc))))).not.toThrow();
    expect(text(a.doc)).toBe('a▮');
  });

  it('attack: 100 000 inserts, then 100 000 deletes, then one insert at index 0 — apply stays fast and buildIndex, apply and snapshot stay well inside the bench budget', () => {
    const inserts: Op[] = [];
    let parent = ROOT.id;
    for (let i = 1; i <= 100_000; i++) {
      const me = id(R.a, i);
      inserts.push(ins(me, parent, 'R', char('x')));
      parent = me;
    }
    const deletes: Op[] = inserts.map((op, i) => del(id(R.b, i + 1), op.id));
    const t0 = performance.now();
    let doc = replay(emptyDoc(), inserts);
    doc = replay(doc, deletes);
    const replayMs = performance.now() - t0;
    expect(visibleItems(doc).length).toBe(0);

    const t1 = performance.now();
    const { doc: after, ops } = localInsert(doc, R.c, 1, 0, char('y'));
    const insertMs = performance.now() - t1;
    // ROOT's right seat is taken by the tombstone chain, so the new item hangs left of the first tombstone.
    expect(ops[0]).toMatchObject({ parent: id(R.a, 1), side: 'L' });
    expect(text(after)).toBe('y');

    const t2 = performance.now();
    const index = buildIndex(after);
    const indexMs = performance.now() - t2;
    expect(index.length).toBe(1);
    expect(index.idAt(0)).toEqual(id(R.c, 1));

    const t3 = performance.now();
    const snap = encodeSnapshot(after);
    const back = decodeSnapshot(snap);
    const snapshotMs = performance.now() - t3;
    expect(snap.items.length).toBe(100_001);
    expect(canonicalString(back)).toBe(canonicalString(after));
    expect(svEqual(back.sv, after.sv)).toBe(true);
    expect(pendingCount(after)).toBe(0);

    // Generous (5×) versions of the LLD §6.4 budgets, so a slow CI runner does not flake but a regression to O(n²) fails.
    expect(replayMs, `replay of 200k ops took ${replayMs.toFixed(0)} ms`).toBeLessThan(7_500);
    expect(insertMs, `insert at 0 over 100k tombstones took ${insertMs.toFixed(0)} ms`).toBeLessThan(750);
    expect(indexMs, `buildIndex took ${indexMs.toFixed(0)} ms`).toBeLessThan(750);
    expect(snapshotMs, `snapshot encode+decode took ${snapshotMs.toFixed(0)} ms`).toBeLessThan(1_500);
  });

  it('attack: 100 000 inserts all as right children of ONE parent (a sibling flood) stay fast, traverse in id order and survive a snapshot round trip (review P7)', () => {
    const flood: Op[] = [];
    for (let i = 1; i <= 100_000; i++) flood.push(ins(id(R.b, i), ROOT.id, 'R', char('x')));
    const t0 = performance.now();
    const doc = replay(emptyDoc(), flood);
    const floodMs = performance.now() - t0;
    expect(doc.children.get(idKey(ROOT.id))?.R.length).toBe(100_000);
    const order = visibleItems(doc).map((item) => item.id.seq);
    expect(order.length).toBe(100_000);
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1] as number);
    const back = decodeSnapshot(JSON.parse(JSON.stringify(encodeSnapshot(doc))));
    expect(canonicalString(back)).toBe(canonicalString(doc));
    // Quadratic sibling copies took 20 s+ here; the chunked list is well under the 2 s target, and 5× that is the flake margin.
    expect(floodMs, `100k sibling inserts took ${floodMs.toFixed(0)} ms`).toBeLessThan(10_000);
  });

  it('attack: two replicas whose ids differ only in the last char insert everywhere concurrently — the order is deterministic and identical on both', () => {
    const x = 'abcdefghijkla' as ReplicaId;
    const y = 'abcdefghijklb' as ReplicaId;
    const base = new Replica(x);
    base.type(0, 'hello world');
    const p = new Replica(x);
    p.doc = base.doc;
    p.seq = base.seq;
    const q = new Replica(y);
    q.receiveAll(base.log);
    for (let i = 0; i <= 11; i++) {
      p.insert(i * 2 > p.length() ? p.length() : i * 2, char('P'));
      q.insert(i * 2 > q.length() ? q.length() : i * 2, char('Q'));
    }
    q.receiveAll(p.log);
    p.receiveAll(q.log);
    expect(text(p.doc)).toBe(text(q.doc));
    expect(canonicalString(p.doc)).toBe(canonicalString(q.doc));
    // Where P and Q compete for the same seat, the lower id (…a) comes first — string order, not locale order.
    expect(text(p.doc).indexOf('P')).toBeLessThan(text(p.doc).indexOf('Q'));
  });

  it('attack: a snapshot with "__proto__" or "constructor" keys anywhere is refused and pollutes nothing', () => {
    const a = new Replica(R.a);
    a.type(0, 'a');
    const good = encodeSnapshot(a.doc);
    const polluted = JSON.parse(
      JSON.stringify(good).replace('"marks":{}', '"marks":{"__proto__":{"active":true,"lamport":1,"replica":"' + R.a + '"},"constructor":{"active":true,"lamport":1,"replica":"' + R.a + '"}}'),
    ) as Snapshot;
    expect(Object.keys((polluted.items[0] as { marks: object }).marks)).toContain('__proto__');
    expect(() => decodeSnapshot(polluted)).toThrow(TypeError);
    expect(({} as Record<string, unknown>)['active']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('active');
    const svPolluted = JSON.parse(JSON.stringify(good).replace('"sv":{', '"sv":{"__proto__":1,')) as Snapshot;
    expect(() => decodeSnapshot(svPolluted)).toThrow(TypeError);
  });

  it('attack: a snapshot whose items reference a parent that is a later item in the array is fine (order is not causality), but a dangling parent is refused', () => {
    const a = new Replica(R.a);
    a.type(0, 'ab');
    const snap = encodeSnapshot(a.doc);
    const reversed: Snapshot = { ...snap, items: [...snap.items].reverse() };
    expect(canonicalString(decodeSnapshot(reversed))).toBe(canonicalString(a.doc));
    const dangling: Snapshot = { ...snap, items: snap.items.slice(1) };
    expect(() => decodeSnapshot(dangling)).toThrow(/unknown parent/);
  });

  it('attack: a hostile fmt naming 100 000 targets it does not hold parks under ONE key and drains or stays bounded, never blowing up per target', () => {
    const targets = Array.from({ length: 100_000 }, (_, i) => id(R.b, i + 1));
    const r = apply(emptyDoc(), fmt(id(R.a, 1), targets, 'bold', true, 1));
    expect(r.kind).toBe('pending');
    expect(pendingCount(r.doc)).toBe(1);
    expect(r.doc.pending.size).toBe(1);
    expect([...r.doc.pending.keys()]).toEqual([idKey(id(R.b, 1))]);
  });
});
