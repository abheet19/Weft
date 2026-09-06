// local.test.ts — local.ts turns intents into ops. Round trips (insert at i, read back at i),
// the denied path (an index past the end is a programmer error and throws RangeError), format
// splitting at MAX_FMT_TARGETS, and block typing through the boundary that closes the block.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyAll, buildIndex, emptyDoc, idKey, localDelete, localFormat, localInsert, localSetBlock, MAX_FMT_TARGETS, ROOT, visibleItems, type Op } from '../src/index.ts';
import { block, char, numRuns, R, Replica, text } from './helpers.ts';

describe('localInsert', () => {
  it('inserting at visible index i makes the new text visible at exactly i', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.nat({ max: 999 }), fc.constantFrom('a', 'b', 'c', '𝄞')), { maxLength: 30 }), (steps) => {
        const rep = new Replica(R.a);
        const mirror: string[] = [];
        for (const [pos, ch] of steps) {
          const i = pos % (mirror.length + 1);
          rep.insert(i, char(ch));
          mirror.splice(i, 0, ch);
          expect(visibleItems(rep.doc).map((it) => (it.content.kind === 'char' ? it.content.text : '▮'))).toEqual(mirror);
        }
      }),
      { numRuns: numRuns('light') },
    );
  });

  it('throws RangeError for an index past the end, a negative index, or a non-integer index, and leaves no trace', () => {
    const rep = new Replica(R.a);
    rep.type(0, 'ab');
    const before = rep.doc;
    expect(() => localInsert(before, R.a, 3, 3, char('x'))).toThrow(RangeError);
    expect(() => localInsert(before, R.a, 3, -1, char('x'))).toThrow(RangeError);
    expect(() => localInsert(before, R.a, 3, 1.5, char('x'))).toThrow(RangeError);
    expect(rep.doc).toBe(before);
  });

  it('throws RangeError when nextSeq is stale (the op would be a duplicate or a gap), naming the reason', () => {
    const rep = new Replica(R.a);
    rep.type(0, 'ab');
    expect(() => localInsert(rep.doc, R.a, 1, 2, char('x'))).toThrow(/duplicate/);
    expect(() => localInsert(rep.doc, R.a, 5, 2, char('x'))).toThrow(/SEQ_GAP/);
    // Reusing the seq of the very item we would hang from is caught earlier still, as a self-parent.
    expect(() => localInsert(rep.doc, R.a, 2, 2, char('x'))).toThrow(/SELF_PARENT/);
  });

  it('returns exactly one op whose id is (me, nextSeq) and whose parent is ROOT for the first insert', () => {
    const { ops, doc } = localInsert(emptyDoc(), R.b, 1, 0, char('q'));
    expect(ops).toEqual([{ t: 'ins', id: { replica: R.b, seq: 1 }, parent: ROOT.id, side: 'R', content: char('q') }]);
    expect(text(doc)).toBe('q');
  });
});

describe('localDelete', () => {
  it('deletes exactly [from, to) and emits one del per item with contiguous seqs', () => {
    const rep = new Replica(R.a);
    rep.type(0, 'abcdef');
    const ops = rep.delete(1, 4);
    expect(text(rep.doc)).toBe('aef');
    expect(ops.map((op) => op.id.seq)).toEqual([7, 8, 9]);
    expect(ops.every((op) => op.t === 'del')).toBe(true);
  });

  it('an empty range emits no ops and returns the same doc', () => {
    const rep = new Replica(R.a);
    rep.type(0, 'abc');
    const { ops, doc } = localDelete(rep.doc, R.a, 4, 2, 2);
    expect(ops).toEqual([]);
    expect(doc).toBe(rep.doc);
  });

  it('throws RangeError when to is past the end or from is after to', () => {
    const rep = new Replica(R.a);
    rep.type(0, 'abc');
    expect(() => localDelete(rep.doc, R.a, 4, 0, 4)).toThrow(RangeError);
    expect(() => localDelete(rep.doc, R.a, 4, 2, 1)).toThrow(RangeError);
  });
});

describe('localFormat', () => {
  it('marks exactly the visible range and nothing else', () => {
    const rep = new Replica(R.a);
    rep.type(0, 'abcd');
    rep.format(1, 3, 'italic', true);
    const flags = visibleItems(rep.doc).map((it) => it.marks.italic?.active === true);
    expect(flags).toEqual([false, true, true, false]);
  });

  it('splits a range wider than MAX_FMT_TARGETS into several ops with the same lamport, none larger than the cap', () => {
    // Build a large doc by direct ops (typing 4 100 chars through localInsert would be O(n²) in a test).
    let doc = emptyDoc();
    let parent = ROOT.id;
    const ops: Op[] = [];
    for (let i = 1; i <= MAX_FMT_TARGETS + 4; i++) {
      const id = { replica: R.a, seq: i };
      ops.push({ t: 'ins', id, parent, side: 'R', content: char('x') });
      parent = id;
    }
    doc = applyAll(doc, ops).doc;
    const { ops: fmts } = localFormat(doc, R.b, 1, 0, MAX_FMT_TARGETS + 4, 'bold', true);
    expect(fmts.length).toBe(2);
    const [first, second] = fmts as [Extract<Op, { t: 'fmt' }>, Extract<Op, { t: 'fmt' }>];
    expect(first.targets.length).toBe(MAX_FMT_TARGETS);
    expect(second.targets.length).toBe(4);
    expect(first.lamport).toBe(second.lamport);
    expect([first.id.seq, second.id.seq]).toEqual([1, 2]);
  });

  it('carries href only for an active link mark', () => {
    const rep = new Replica(R.a);
    rep.type(0, 'ab');
    const [linkOn] = rep.format(0, 2, 'link', true, 'https://weft.test/');
    expect(linkOn).toMatchObject({ mark: 'link', href: 'https://weft.test/' });
    const [linkOff] = rep.format(0, 2, 'link', false, 'https://weft.test/');
    expect(linkOff).not.toHaveProperty('href');
    const [bold] = rep.format(0, 2, 'bold', true, 'https://weft.test/');
    expect(bold).not.toHaveProperty('href');
  });

  it('uses a lamport above every formatting lamport seen so the local write wins over earlier remote ones', () => {
    const rep = new Replica(R.a);
    rep.type(0, 'a');
    const remote = new Replica(R.b);
    remote.receiveAll(rep.log);
    remote.format(0, 1, 'bold', true);
    rep.receiveAll(remote.log);
    rep.format(0, 1, 'bold', false);
    expect(visibleItems(rep.doc)[0]?.marks.bold).toMatchObject({ active: false, replica: R.a });
  });
});

describe('localSetBlock', () => {
  it('retypes the block containing the position by targeting the boundary that closes it', () => {
    const rep = new Replica(R.a);
    rep.type(0, 'ab');
    rep.insert(2, block({ type: 'paragraph' }, R.a));
    rep.type(3, 'cd');
    rep.insert(5, block({ type: 'paragraph' }, R.a));
    rep.setBlock(3, { type: 'heading', level: 2 }); // position 3 is inside the second block
    const ranges = buildIndex(rep.doc).blockRanges();
    expect(ranges.map((r) => r.attrs)).toEqual([{ type: 'paragraph' }, { type: 'heading', level: 2 }, { type: 'paragraph' }]);
    // The position just before a boundary belongs to the block that boundary closes.
    rep.setBlock(2, { type: 'quote' });
    expect(buildIndex(rep.doc).blockRanges()[0]?.attrs).toEqual({ type: 'quote' });
    expect(idKey(ranges[2]?.boundary as never)).toBe(idKey(ROOT.id));
  });

  it('throws RangeError for the trailing block (closed by the root sentinel) and for an index past the end', () => {
    const rep = new Replica(R.a);
    rep.type(0, 'ab');
    expect(() => localSetBlock(rep.doc, R.a, 3, 1, { type: 'quote' })).toThrow(/root sentinel/);
    expect(() => localSetBlock(rep.doc, R.a, 3, 9, { type: 'quote' })).toThrow(RangeError);
  });
});
