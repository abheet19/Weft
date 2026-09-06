// apply.test.ts — example tests for `apply`: the design §2.7 worked example, the Fugue paper's
// insert-rule cases, the denied paths (every RejectReason, doc unchanged), totality over
// malformed shapes (review P1/P5/P6), the interrupted path (a prefix then the rest ≡ all at once),
// the pending buffer's park/drain behaviour, the LWW total order (review P3) and the lamport
// bound (review P2).
import { describe, expect, it } from 'vitest';
import {
  apply,
  applyAll,
  canonicalString,
  dropPending,
  emptyDoc,
  getItem,
  idKey,
  localFormat,
  localSetBlock,
  MAX_LAMPORT,
  pendingCount,
  ROOT,
  ROOT_REPLICA,
  siblingArray,
  svGet,
  unsatisfiablePending,
  type Doc,
  type Item,
  type Op,
} from '../src/index.ts';
import { applied, appliedAll, blk, char, del, fmt, id, ins, R, Replica, text, block } from './helpers.ts';

describe('design §2.7: concurrent inserts at the same position', () => {
  it('both replicas show "Hi there!" after a and b type " there" and "!" after "Hi" while offline', () => {
    const a = new Replica(R.a);
    a.type(0, 'Hi');
    const b = new Replica(R.b);
    b.receiveAll(a.log);
    expect(text(b.doc)).toBe('Hi');

    a.type(2, ' there');
    b.type(2, '!');
    expect(text(a.doc)).toBe('Hi there');
    expect(text(b.doc)).toBe('Hi!');

    b.receiveAll(a.log.slice(2));
    a.receiveAll(b.log);
    expect(text(a.doc)).toBe('Hi there!');
    expect(text(b.doc)).toBe('Hi there!');
  });

  it('the space and the "!" are both right children of "i", ordered by replica id', () => {
    const a = new Replica(R.a);
    a.type(0, 'Hi');
    const b = new Replica(R.b);
    b.receiveAll(a.log);
    a.type(2, ' ');
    b.type(2, '!'); // b's own first op: (b, 1)
    a.receiveAll(b.log);
    const i = id(R.a, 2);
    expect(siblingArray(a.doc.children.get(idKey(i))?.R ?? { length: 0, chunks: [] })).toEqual([id(R.a, 3), id(R.b, 1)]);
    expect(getItem(a.doc, id(R.b, 1))?.parent).toEqual(i);
  });
});

describe('the Fugue insert rule (paper §3)', () => {
  it('places a new item as the right child of its left neighbour when that seat is free', () => {
    const a = new Replica(R.a);
    a.type(0, 'ab'); // b already sits in a's right seat, so only b's right seat is free
    const [op] = a.insert(2, char('x'));
    expect(op).toMatchObject({ t: 'ins', parent: id(R.a, 2), side: 'R' });
    expect(text(a.doc)).toBe('abx');
  });

  it('places a new item as the left child of its right neighbour when the left neighbour already has a right child', () => {
    const a = new Replica(R.a);
    a.type(0, 'ab'); // b is the right child of a
    const [op] = a.insert(1, char('x')); // between a and b: a's right seat is taken by b
    expect(op).toMatchObject({ t: 'ins', parent: id(R.a, 2), side: 'L' });
    expect(text(a.doc)).toBe('axb');
  });

  it('uses the tombstone as the right neighbour, not the next visible item, so both replicas agree', () => {
    // a: "abc", delete b. Inserting between a and c: a's right child is the tombstone b (taken), so
    // the new item must hang LEFT of the tombstone b — not left of the visible c.
    const a = new Replica(R.a);
    a.type(0, 'abc');
    a.delete(1, 2);
    expect(text(a.doc)).toBe('ac');
    const [op] = a.insert(1, char('x'));
    expect(op).toMatchObject({ parent: id(R.a, 2), side: 'L' });
    expect(text(a.doc)).toBe('axc');
  });

  it('inserting at index 0 of a non-empty doc hangs the item left of the first item, never left of ROOT', () => {
    const a = new Replica(R.a);
    a.type(0, 'b');
    const [op] = a.insert(0, char('a'));
    expect(op).toMatchObject({ parent: id(R.a, 1), side: 'L' });
    expect(text(a.doc)).toBe('ab');
  });

  it('a backward-typed run (cursor fixed, prepending) is a left-leaning chain and reads in order', () => {
    const a = new Replica(R.a);
    a.type(0, 'X');
    a.prepend(0, 'abc');
    expect(text(a.doc)).toBe('abcX');
    expect(getItem(a.doc, id(R.a, 2))?.parent).toEqual(id(R.a, 1)); // 'c' left of X
    expect(getItem(a.doc, id(R.a, 3))?.parent).toEqual(id(R.a, 2)); // 'b' left of c
    expect(getItem(a.doc, id(R.a, 4))?.parent).toEqual(id(R.a, 3)); // 'a' left of b
  });
});

describe('denied paths: every RejectReason leaves the doc untouched', () => {
  const base = appliedAll(emptyDoc(), [ins(id(R.a, 1), ROOT.id, 'R', char('a'))]);

  it('rejects a seq that is not the replica’s next seq with SEQ_GAP', () => {
    const r = apply(base, ins(id(R.a, 3), id(R.a, 1), 'R'));
    expect(r).toMatchObject({ kind: 'rejected', reason: 'SEQ_GAP' });
    expect(r.doc).toBe(base);
  });

  it('rejects seq 0 with MALFORMED (seqs start at 1; 0 is ROOT’s alone, not a gap)', () => {
    const r = apply(emptyDoc(), ins(id(R.b, 0), ROOT.id, 'R'));
    expect(r).toMatchObject({ kind: 'rejected', reason: 'MALFORMED' });
  });

  it('rejects a del whose target is ROOT with TARGET_IS_ROOT', () => {
    const r = apply(base, del(id(R.a, 2), ROOT.id));
    expect(r).toMatchObject({ kind: 'rejected', reason: 'TARGET_IS_ROOT' });
    expect(r.doc).toBe(base);
  });

  it('rejects a fmt or blk aimed at ROOT with TARGET_IS_ROOT', () => {
    expect(apply(base, fmt(id(R.a, 2), [id(R.a, 1), ROOT.id], 'bold', true, 1))).toMatchObject({ kind: 'rejected', reason: 'TARGET_IS_ROOT' });
    expect(apply(base, blk(id(R.a, 2), ROOT.id, { type: 'quote' }, 1))).toMatchObject({ kind: 'rejected', reason: 'TARGET_IS_ROOT' });
  });

  it('rejects an insert that names itself as parent with SELF_PARENT', () => {
    const r = apply(base, ins(id(R.a, 2), id(R.a, 2), 'R'));
    expect(r).toMatchObject({ kind: 'rejected', reason: 'SELF_PARENT' });
    expect(r.doc).toBe(base);
  });

  it('rejects a del, fmt or blk that depends on its own id with SELF_PARENT (it could never be satisfied)', () => {
    expect(apply(base, del(id(R.a, 2), id(R.a, 2)))).toMatchObject({ kind: 'rejected', reason: 'SELF_PARENT' });
    expect(apply(base, fmt(id(R.a, 2), [id(R.a, 2)], 'bold', true, 1))).toMatchObject({ kind: 'rejected', reason: 'SELF_PARENT' });
    expect(apply(base, blk(id(R.a, 2), id(R.a, 2), { type: 'quote' }, 1))).toMatchObject({ kind: 'rejected', reason: 'SELF_PARENT' });
  });

  it('rejects a left child of ROOT with BAD_PARENT_SIDE', () => {
    const r = apply(base, ins(id(R.a, 2), ROOT.id, 'L'));
    expect(r).toMatchObject({ kind: 'rejected', reason: 'BAD_PARENT_SIDE' });
    expect(r.doc).toBe(base);
  });

  it('rejects a side that is neither L nor R with BAD_PARENT_SIDE', () => {
    const r = apply(base, { ...ins(id(R.a, 2), id(R.a, 1), 'R'), side: 'X' as 'R' });
    expect(r).toMatchObject({ kind: 'rejected', reason: 'BAD_PARENT_SIDE' });
  });

  it('rejects an op of unknown type as MALFORMED, so its seq is never consumed', () => {
    const r = apply(base, { t: 'mov', id: id(R.a, 2) } as unknown as Op);
    expect(r).toMatchObject({ kind: 'rejected', reason: 'MALFORMED' });
    expect(svGet(r.doc.sv, R.a)).toBe(1);
  });

  it('is total: null, a string, and ops whose parent, target or targets are missing, null, a string or a number are rejected MALFORMED — never thrown, never parked (review P1)', () => {
    const probes: unknown[] = [
      null,
      'ins',
      { t: 'ins', parent: ROOT.id, side: 'R', content: char('x') },
      { t: 'ins', id: id(R.b, 1), side: 'R', content: char('x') },
      { t: 'ins', id: id(R.b, 1), parent: null, side: 'R', content: char('x') },
      { t: 'ins', id: id(R.b, 1), parent: `${R.a}:1`, side: 'R', content: char('x') },
      { t: 'del', id: id(R.b, 1) },
      { t: 'del', id: id(R.b, 1), target: 1 },
      { t: 'fmt', id: id(R.b, 1), targets: [null], mark: 'bold', active: true, lamport: 1 },
      { t: 'fmt', id: id(R.b, 1), targets: [1], mark: 'bold', active: true, lamport: 1 },
      { t: 'fmt', id: id(R.b, 1), targets: 'all', mark: 'bold', active: true, lamport: 1 },
      { t: 'blk', id: id(R.b, 1), attrs: { type: 'quote' }, lamport: 1 },
    ];
    for (const probe of probes) {
      const r = apply(base, probe as Op);
      expect(r, JSON.stringify(probe)).toMatchObject({ kind: 'rejected', reason: 'MALFORMED' });
      expect(r.doc).toBe(base);
    }
    expect(pendingCount(base)).toBe(0);
  });

  it('rejects char content that is not exactly one code point — "", "abc", a lone surrogate, U+0000 — and accepts an astral char (review P5)', () => {
    for (const bad of ['', 'abc', '\ud83d', '\udd0d', 'a\u0000b', '\u0000']) {
      const r = apply(base, ins(id(R.b, 1), id(R.a, 1), 'R', char(bad)));
      expect(r, JSON.stringify(bad)).toMatchObject({ kind: 'rejected', reason: 'MALFORMED' });
    }
    const r = apply(base, ins(id(R.b, 1), id(R.a, 1), 'R', char('𝄞')));
    expect(r.kind).toBe('applied');
    expect(text(r.doc)).toBe('a𝄞');
  });

  it('rejects an op authored by the reserved ROOT replica as MALFORMED (review P6)', () => {
    const r = apply(base, ins(id(ROOT_REPLICA, 1), id(R.a, 1), 'R', char('!')));
    expect(r).toMatchObject({ kind: 'rejected', reason: 'MALFORMED' });
    expect(apply(base, del(id(ROOT_REPLICA, 1), id(R.a, 1)))).toMatchObject({ kind: 'rejected', reason: 'MALFORMED' });
    expect(text(r.doc)).toBe('a');
  });

  it('rejects a block seed whose replica is not the op’s author, so the stored register always names the writing op', () => {
    const r = apply(base, ins(id(R.b, 1), id(R.a, 1), 'R', block({ type: 'quote' }, R.c)));
    expect(r).toMatchObject({ kind: 'rejected', reason: 'MALFORMED' });
    expect(apply(base, ins(id(R.b, 1), id(R.a, 1), 'R', block({ type: 'quote' }, R.b))).kind).toBe('applied');
  });

  it('rejects a lamport above MAX_LAMPORT on a fmt, a blk or a block seed as MALFORMED', () => {
    const over = MAX_LAMPORT + 1;
    expect(apply(base, fmt(id(R.b, 1), [id(R.a, 1)], 'bold', true, over))).toMatchObject({ kind: 'rejected', reason: 'MALFORMED' });
    expect(apply(base, blk(id(R.b, 1), id(R.a, 1), { type: 'quote' }, over))).toMatchObject({ kind: 'rejected', reason: 'MALFORMED' });
    expect(apply(base, ins(id(R.b, 1), id(R.a, 1), 'R', block({ type: 'quote' }, R.b, over)))).toMatchObject({ kind: 'rejected', reason: 'MALFORMED' });
    expect(apply(base, fmt(id(R.b, 1), [id(R.a, 1)], 'bold', true, MAX_LAMPORT)).kind).toBe('applied');
  });

  it('a remote op with lamport 2^53−1 is refused, so local formatting keeps working afterwards (review P2)', () => {
    const r = apply(base, fmt(id(R.b, 1), [id(R.a, 1)], 'bold', true, Number.MAX_SAFE_INTEGER));
    expect(r).toMatchObject({ kind: 'rejected', reason: 'MALFORMED' });
    expect(r.doc.formatLamport).toBe(0);
    const { doc } = localFormat(r.doc, R.a, 2, 0, 1, 'italic', true);
    expect(doc.items.get(idKey(id(R.a, 1)))?.marks.italic).toMatchObject({ active: true, lamport: 1 });
    const seeded = apply(base, ins(id(R.b, 1), id(R.a, 1), 'R', block({ type: 'paragraph' }, R.b, Number.MAX_SAFE_INTEGER)));
    expect(seeded).toMatchObject({ kind: 'rejected', reason: 'MALFORMED' });
  });

  it('at MAX_LAMPORT, localFormat and localSetBlock throw a RangeError that names the bound instead of emitting an op apply would refuse', () => {
    const withBoundary = applied(base, ins(id(R.a, 2), id(R.a, 1), 'R', block({ type: 'paragraph' }, R.a)));
    const atBound = applied(withBoundary, fmt(id(R.b, 1), [id(R.a, 1)], 'bold', true, MAX_LAMPORT));
    expect(atBound.formatLamport).toBe(MAX_LAMPORT);
    expect(() => localFormat(atBound, R.a, 3, 0, 1, 'italic', true)).toThrow(/MAX_LAMPORT \(2147483647\)/);
    expect(() => localSetBlock(atBound, R.a, 3, 0, { type: 'quote' })).toThrow(RangeError);
  });

  it('applies to a hand-built Doc whose maps are plain Maps by converting them once (review P10)', () => {
    const plain: Doc = { items: new Map<string, Item>(base.items), children: new Map(base.children), sv: base.sv, pending: new Map(), formatLamport: 0 };
    const r = apply(plain, ins(id(R.b, 1), id(R.a, 1), 'R', char('b')));
    expect(r.kind).toBe('applied');
    expect(text(r.doc)).toBe('ab');
    expect(plain.items.size).toBe(2); // the plain Map was not mutated
  });

  it('a rejected op does not advance the state vector, so the replica’s next honest op is a gap too', () => {
    const r1 = apply(base, ins(id(R.a, 2), ROOT.id, 'L'));
    const r2 = apply(r1.doc, ins(id(R.a, 3), id(R.a, 1), 'R'));
    expect(r2).toMatchObject({ kind: 'rejected', reason: 'SEQ_GAP' });
  });
});

describe('idempotence and the pending buffer', () => {
  it('applying the same op twice returns duplicate the second time and the identical doc object', () => {
    const op = ins(id(R.a, 1), ROOT.id, 'R', char('a'));
    const d1 = applied(emptyDoc(), op);
    const r = apply(d1, op);
    expect(r.kind).toBe('duplicate');
    expect(r.doc).toBe(d1);
  });

  it('parks an insert whose parent has not arrived and drains it when it does', () => {
    const parent = ins(id(R.a, 1), ROOT.id, 'R', char('a'));
    const child = ins(id(R.b, 1), id(R.a, 1), 'R', char('b'));
    const r1 = apply(emptyDoc(), child);
    expect(r1.kind).toBe('pending');
    if (r1.kind === 'pending') expect(r1.missing).toEqual([id(R.a, 1)]);
    expect(pendingCount(r1.doc)).toBe(1);
    expect(text(r1.doc)).toBe('');

    const r2 = apply(r1.doc, parent);
    expect(r2.kind).toBe('applied');
    if (r2.kind === 'applied') expect(r2.drained).toEqual([child]);
    expect(pendingCount(r2.doc)).toBe(0);
    expect(text(r2.doc)).toBe('ab');
  });

  it('drains transitively: a child parked on a parent that is itself parked lands with it', () => {
    const a = new Replica(R.a);
    a.type(0, 'a');
    const c = new Replica(R.c);
    c.receiveAll(a.log);
    c.type(1, 'b'); // c:1 hangs under a:1
    const late = new Replica(R.b);
    const r1 = late.receive(c.log[0] as Op); // c:1 needs a:1
    expect(r1.kind).toBe('pending');
    const r2 = late.receive(a.log[0] as Op); // a:1 lands and drains c:1
    expect(r2.kind).toBe('applied');
    if (r2.kind === 'applied') expect(r2.drained.map((op) => idKey(op.id))).toEqual([idKey(id(R.c, 1))]);
    expect(pendingCount(late.doc)).toBe(0);
    expect(text(late.doc)).toBe('ab');
  });

  it('a chain parked at every link drains in one go when the root of the chain lands', () => {
    // a types "abc": a:1←a:2←a:3. Receiver gets a:3? No — same-replica seqs must be contiguous, so the
    // receiver gets a:1 last only via a cross-replica chain: a:1, then b:1 (child of a:1), then c:1 (child of b:1).
    const a = new Replica(R.a);
    a.type(0, 'a');
    const b = new Replica(R.b);
    b.receiveAll(a.log);
    b.type(1, 'b');
    const c = new Replica(R.c);
    c.receiveAll(a.log);
    c.receiveAll(b.log);
    c.type(2, 'c');

    const late = new Replica(R.d);
    expect(late.receive(c.log[0] as Op).kind).toBe('pending'); // needs b:1
    expect(late.receive(b.log[0] as Op).kind).toBe('pending'); // needs a:1
    expect(pendingCount(late.doc)).toBe(2);
    const r = late.receive(a.log[0] as Op);
    expect(r.kind).toBe('applied');
    if (r.kind === 'applied') expect(r.drained.map((op) => idKey(op.id))).toEqual([idKey(id(R.b, 1)), idKey(id(R.c, 1))]);
    expect(pendingCount(late.doc)).toBe(0);
    expect(text(late.doc)).toBe('abc');
  });

  it('a parked op with several missing targets is re-parked under the next missing one until all have landed', () => {
    const a = new Replica(R.a);
    a.type(0, 'x');
    const b = new Replica(R.b);
    b.type(0, 'y');
    const c = new Replica(R.c);
    c.receiveAll(a.log);
    c.receiveAll(b.log);
    c.format(0, 2, 'bold', true); // targets a:1 and b:1

    const late = new Replica(R.d);
    const r1 = late.receive(c.log[0] as Op);
    expect(r1.kind).toBe('pending');
    if (r1.kind === 'pending') expect(r1.missing.length).toBe(2);
    late.receive(a.log[0] as Op);
    expect(pendingCount(late.doc)).toBe(1); // still waiting for b:1
    late.receive(b.log[0] as Op);
    expect(pendingCount(late.doc)).toBe(0);
    expect(late.doc.items.get(idKey(id(R.a, 1)))?.marks.bold?.active).toBe(true);
    expect(late.doc.items.get(idKey(id(R.b, 1)))?.marks.bold?.active).toBe(true);
  });

  it('a parked op counts in the state vector, so its successor from the same replica is not a gap', () => {
    const a = new Replica(R.a);
    a.type(0, 'a');
    const b = new Replica(R.b);
    b.receiveAll(a.log);
    b.type(1, 'b'); // b:1 under a:1
    b.type(2, 'c'); // b:2 under b:1
    const late = new Replica(R.c);
    expect(late.receive(b.log[0] as Op).kind).toBe('pending');
    expect(late.receive(b.log[1] as Op).kind).toBe('pending');
    expect(svGet(late.doc.sv, R.b)).toBe(2);
    late.receive(a.log[0] as Op);
    expect(text(late.doc)).toBe('abc');
  });
});

describe('interrupted path', () => {
  it('applyAll of a prefix and then the rest gives the same doc as all at once (resume after a crash)', () => {
    const a = new Replica(R.a);
    a.type(0, 'hello world');
    a.delete(5, 6);
    a.format(0, 5, 'bold', true);
    a.insert(5, block({ type: 'heading', level: 2 }, R.a));
    const ops = a.log;
    const whole = applyAll(emptyDoc(), ops).doc;
    for (let cut = 0; cut <= ops.length; cut++) {
      const first = applyAll(emptyDoc(), ops.slice(0, cut)).doc;
      const resumed = applyAll(first, ops.slice(cut)).doc;
      expect(text(resumed)).toBe(text(whole));
      expect(resumed.sv).toEqual(whole.sv);
      expect(resumed.formatLamport).toBe(whole.formatLamport);
    }
  });
});

describe('deletes, formats and blocks', () => {
  it('deleting a tombstone again is applied and changes nothing', () => {
    const a = new Replica(R.a);
    a.type(0, 'ab');
    a.delete(0, 1);
    const before = a.doc;
    const r = apply(before, del(id(R.b, 1), id(R.a, 1)));
    expect(r.kind).toBe('applied');
    expect(text(r.doc)).toBe('b');
    expect(r.doc.items.get(idKey(id(R.a, 1)))).toBe(before.items.get(idKey(id(R.a, 1))));
  });

  it('formatting is last-writer-wins on lamport, then on replica id', () => {
    const a = new Replica(R.a);
    a.type(0, 'a');
    const target = id(R.a, 1);
    let doc = a.doc;
    doc = applied(doc, fmt(id(R.b, 1), [target], 'bold', true, 5));
    doc = applied(doc, fmt(id(R.c, 1), [target], 'bold', false, 4)); // lower lamport loses
    expect(doc.items.get(idKey(target))?.marks.bold).toMatchObject({ active: true, lamport: 5, replica: R.b });
    doc = applied(doc, fmt(id(R.d, 1), [target], 'bold', false, 5)); // same lamport, higher replica wins
    expect(doc.items.get(idKey(target))?.marks.bold).toMatchObject({ active: false, lamport: 5, replica: R.d });
    doc = applied(doc, fmt(id(R.a, 2), [target], 'bold', true, 5)); // same lamport, lower replica loses
    expect(doc.items.get(idKey(target))?.marks.bold?.active).toBe(false);
    expect(doc.formatLamport).toBe(5);
  });

  it('a link mark stores its href and any other mark ignores one', () => {
    const a = new Replica(R.a);
    a.type(0, 'a');
    const target = id(R.a, 1);
    let doc = applied(a.doc, fmt(id(R.b, 1), [target], 'link', true, 1, 'https://weft.test/'));
    expect(doc.items.get(idKey(target))?.marks.link).toEqual({ active: true, lamport: 1, replica: R.b, seq: 1, href: 'https://weft.test/' });
    doc = applied(doc, fmt(id(R.b, 2), [target], 'bold', true, 2, 'https://ignored.test/'));
    expect(doc.items.get(idKey(target))?.marks.bold).toEqual({ active: true, lamport: 2, replica: R.b, seq: 2 });
  });

  it('a blk on a boundary is last-writer-wins and a blk on a character changes nothing', () => {
    const a = new Replica(R.a);
    a.insert(0, block({ type: 'paragraph' }, R.a));
    a.type(0, 'x');
    const boundary = id(R.a, 1);
    const ch = id(R.a, 2);
    let doc = applied(a.doc, blk(id(R.b, 1), boundary, { type: 'heading', level: 1 }, 3));
    expect(doc.items.get(idKey(boundary))?.content).toEqual({ kind: 'block', attrs: { type: 'heading', level: 1 }, lamport: 3, replica: R.b, seq: 1 });
    doc = applied(doc, blk(id(R.c, 1), boundary, { type: 'quote' }, 2));
    expect(doc.items.get(idKey(boundary))?.content).toMatchObject({ attrs: { type: 'heading', level: 1 } });
    const before = doc;
    doc = applied(doc, blk(id(R.d, 1), ch, { type: 'quote' }, 9));
    expect(doc.items.get(idKey(ch))).toBe(before.items.get(idKey(ch)));
    expect(doc.formatLamport).toBe(9);
  });

  it('breaks an LWW tie on equal lamport and replica by the writing op’s seq, so two fmt ops from one replica converge whichever one was parked (review P3)', () => {
    // World: a holds item a:1 ("a"), c holds item c:1 ("c"). b sends b:1 bold=true on both with
    // lamport 7, then b:2 bold=false on a:1 with the SAME lamport 7 (a lamport is only "seen so far
    // plus one", so this is well-formed and honest under concurrency).
    const a1 = ins(id(R.a, 1), ROOT.id, 'R', char('a'));
    const c1 = ins(id(R.c, 1), ROOT.id, 'R', char('c'));
    const b1 = fmt(id(R.b, 1), [id(R.a, 1), id(R.c, 1)], 'bold', true, 7);
    const b2 = fmt(id(R.b, 2), [id(R.a, 1)], 'bold', false, 7);
    const inOrder = applyAll(emptyDoc(), [a1, c1, b1, b2]).doc; // b1 lands before b2
    const parked = applyAll(emptyDoc(), [a1, b1, b2, c1]).doc; // b1 waits for c1, so b2 lands first
    const reversed = applyAll(emptyDoc(), [c1, b1, b2, a1]).doc; // both wait for a1 and drain together
    for (const doc of [inOrder, parked, reversed]) {
      expect(pendingCount(doc)).toBe(0);
      expect(canonicalString(doc)).toBe('[["a",[]],["c",["bold"]]]');
      expect(doc.items.get(idKey(id(R.a, 1)))?.marks.bold).toEqual({ active: false, lamport: 7, replica: R.b, seq: 2 });
    }
  });

  it('a fmt with no targets is applied, consumes its seq and raises the format lamport', () => {
    const r = apply(emptyDoc(), fmt(id(R.a, 1), [], 'italic', true, 7));
    expect(r.kind).toBe('applied');
    expect(svGet(r.doc.sv, R.a)).toBe(1);
    expect(r.doc.formatLamport).toBe(7);
  });
});

describe('unsatisfiable dependencies (E1/E12)', () => {
  const base = appliedAll(emptyDoc(), [ins(id(R.a, 1), ROOT.id, 'R', char('a'))]);

  it('names a parked op whose dependency is counted by the state vector yet created no item — that op was not an insert, so the item never comes', () => {
    // b:1 is a del of a:1; c:1 then names b:1 as its parent. Once b:1 is held, c:1 can never drain.
    const doc = applied(base, del(id(R.b, 1), id(R.a, 1)));
    const r = apply(doc, ins(id(R.c, 1), id(R.b, 1), 'R', char('x')));
    expect(r.kind).toBe('pending');
    expect(unsatisfiablePending(r.doc, r.doc.sv)).toEqual([ins(id(R.c, 1), id(R.b, 1), 'R', char('x'))]);
    // Before b:1 is held, nothing can be said: b:1 might still be the insert c:1 needs.
    const early = apply(base, ins(id(R.c, 1), id(R.b, 1), 'R', char('x')));
    expect(unsatisfiablePending(early.doc, early.doc.sv)).toEqual([]);
  });

  it('does not name an op parked on an insert that is itself parked, but does once that insert is found dead', () => {
    // c:1 hangs on b:2 (not yet held); c:2 hangs on c:1. Then b:1 and b:2 arrive and are both dels.
    const c1 = ins(id(R.c, 1), id(R.b, 2), 'R', char('x'));
    const c2 = ins(id(R.c, 2), id(R.c, 1), 'R', char('y'));
    let doc = applyAll(base, [c1, c2]).doc;
    expect(pendingCount(doc)).toBe(2);
    expect(unsatisfiablePending(doc, doc.sv)).toEqual([]); // b:2 is not held yet; c:2 waits on a live insert
    doc = applyAll(doc, [del(id(R.b, 1), id(R.a, 1)), del(id(R.b, 2), id(R.a, 1))]).doc;
    expect(unsatisfiablePending(doc, doc.sv).map((op) => idKey(op.id)).sort()).toEqual([idKey(id(R.c, 1)), idKey(id(R.c, 2))]);
  });

  it('dropPending removes exactly the given ops, keeps the state vector, and leaves the doc untouched when there is nothing to drop', () => {
    const dead = ins(id(R.c, 1), id(R.b, 1), 'R', char('x'));
    const live = ins(id(R.d, 1), id(R.b, 2), 'R', char('y'));
    const doc = applyAll(applied(base, del(id(R.b, 1), id(R.a, 1))), [dead, live]).doc;
    expect(pendingCount(doc)).toBe(2);
    const dropped = dropPending(doc, unsatisfiablePending(doc, doc.sv));
    expect(pendingCount(dropped)).toBe(1);
    expect([...dropped.pending.values()].flat()).toEqual([live]);
    expect(dropped.sv).toEqual(doc.sv);
    expect(dropPending(dropped, [])).toBe(dropped);
    expect(pendingCount(dropPending(dropped, [dead]))).toBe(1);
  });
});
