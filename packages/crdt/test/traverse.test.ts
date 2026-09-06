// traverse.test.ts — the traversal is the document. buildIndex must agree with visibleItems for
// random docs (property), nextInTraversal must include tombstones, block ranges must tile the
// document and end with the root-closed trailing block, and a 100 000-deep chain must not recurse.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildIndex, emptyDoc, idKey, nextInTraversal, ROOT, traversalOrder, visibleItems, type ItemId, type Op } from '../src/index.ts';
import { arbScript, perform } from './generators.ts';
import { block, char, numRuns, R, replay, Replica } from './helpers.ts';

describe('buildIndex', () => {
  it('agrees with visibleItems on length, idAt and indexOf for random documents, after every op', () => {
    fc.assert(
      fc.property(arbScript, (script) => {
        const rep = new Replica(R.a);
        for (const intent of script) {
          perform(rep, intent);
          const visible = visibleItems(rep.doc);
          const index = buildIndex(rep.doc);
          expect(index.length).toBe(visible.length);
          visible.forEach((item, i) => {
            expect(index.idAt(i)).toEqual(item.id);
            expect(index.indexOf(item.id)).toBe(i);
          });
          expect(index.idAt(visible.length)).toBeNull();
          for (const item of traversalOrder(rep.doc)) if (item.deleted) expect(index.indexOf(item.id)).toBe(-1);
        }
      }),
      { numRuns: numRuns('light') },
    );
  });

  it('visibleBefore counts the live items ahead of any item, tombstones included, for random documents', () => {
    fc.assert(
      fc.property(arbScript, (script) => {
        const rep = new Replica(R.a);
        for (const intent of script) perform(rep, intent);
        const index = buildIndex(rep.doc);
        let live = 0;
        for (const item of traversalOrder(rep.doc)) {
          expect(index.visibleBefore(item.id)).toBe(live);
          if (!item.deleted) live++;
        }
        expect(index.visibleBefore({ replica: R.b, seq: 1 })).toBe(-1);
      }),
      { numRuns: numRuns('light') },
    );
  });

  it('a deleted item keeps its place between its live neighbours: a cursor anchored to it lands there', () => {
    const rep = new Replica(R.a);
    rep.type(0, 'abc');
    rep.delete(1, 2);
    const index = buildIndex(rep.doc);
    expect(index.indexOf({ replica: R.a, seq: 2 })).toBe(-1);
    expect(index.visibleBefore({ replica: R.a, seq: 2 })).toBe(1);
    expect(index.visibleBefore({ replica: R.a, seq: 3 })).toBe(1);
  });

  it('returns null at the end and -1 for unknown or deleted ids', () => {
    const rep = new Replica(R.a);
    rep.type(0, 'ab');
    rep.delete(0, 1);
    const index = buildIndex(rep.doc);
    expect(index.length).toBe(1);
    expect(index.idAt(1)).toBeNull();
    expect(index.idAt(-1)).toBeNull();
    expect(index.indexOf({ replica: R.a, seq: 1 })).toBe(-1);
    expect(index.indexOf({ replica: R.b, seq: 1 })).toBe(-1);
  });

  it('block ranges tile the visible sequence and always end with the trailing block closed by ROOT', () => {
    const rep = new Replica(R.a);
    expect(buildIndex(rep.doc).blockRanges()).toEqual([{ from: 0, to: 0, boundary: ROOT.id, attrs: { type: 'paragraph' } }]);
    rep.type(0, 'ab');
    rep.insert(2, block({ type: 'heading', level: 1 }, R.a));
    rep.type(3, 'c');
    const ranges = buildIndex(rep.doc).blockRanges();
    expect(ranges.length).toBe(2);
    expect(ranges[0]).toMatchObject({ from: 0, to: 2, attrs: { type: 'heading', level: 1 } });
    expect(ranges[1]).toMatchObject({ from: 3, to: 4, boundary: ROOT.id, attrs: { type: 'paragraph' } });
  });

  it('caches its block ranges: two calls return the same array', () => {
    const rep = new Replica(R.a);
    rep.type(0, 'a');
    const index = buildIndex(rep.doc);
    expect(index.blockRanges()).toBe(index.blockRanges());
  });
});

describe('nextInTraversal', () => {
  it('returns the tombstone that follows, not the next visible item', () => {
    const rep = new Replica(R.a);
    rep.type(0, 'abc');
    rep.delete(1, 2);
    expect(nextInTraversal(rep.doc, { replica: R.a, seq: 1 })).toEqual({ replica: R.a, seq: 2 });
    expect(nextInTraversal(rep.doc, { replica: R.a, seq: 2 })).toEqual({ replica: R.a, seq: 3 });
    expect(nextInTraversal(rep.doc, { replica: R.a, seq: 3 })).toBeNull();
  });

  it('agrees with traversalOrder from ROOT through every item to null, for random documents', () => {
    fc.assert(
      fc.property(arbScript, (script) => {
        const rep = new Replica(R.a);
        for (const intent of script) perform(rep, intent);
        const order = traversalOrder(rep.doc);
        let cur: ItemId | null = ROOT.id;
        for (const item of order) {
          cur = nextInTraversal(rep.doc, cur as ItemId);
          expect(cur).not.toBeNull();
          expect(idKey(cur as ItemId)).toBe(idKey(item.id));
        }
        expect(nextInTraversal(rep.doc, cur as ItemId)).toBeNull();
      }),
      { numRuns: numRuns('light') },
    );
  });

  it('climbs past a right child with no later sibling to the parent’s successor, and from a left child to the parent', () => {
    // a b, then x inserted between (left child of b): traversal a x b. next(x) = b; next(a) = x; next(b) = null.
    const rep = new Replica(R.a);
    rep.type(0, 'ab');
    rep.insert(1, char('x'));
    const [a, b, x] = [1, 2, 3].map((seq) => ({ replica: R.a, seq }));
    expect(nextInTraversal(rep.doc, a as ItemId)).toEqual(x);
    expect(nextInTraversal(rep.doc, x as ItemId)).toEqual(b);
    expect(nextInTraversal(rep.doc, b as ItemId)).toBeNull();
    expect(nextInTraversal(rep.doc, ROOT.id)).toEqual(a);
  });

  it('returns null for an unknown id', () => {
    expect(nextInTraversal(emptyDoc(), { replica: R.b, seq: 7 })).toBeNull();
  });
});

describe('deep documents', () => {
  it('traverses a 100 000-item forward-typed chain and a 100 000-item prepended chain without recursion', () => {
    const forward: Op[] = [];
    let parent = ROOT.id;
    for (let i = 1; i <= 100_000; i++) {
      const id = { replica: R.a, seq: i };
      forward.push({ t: 'ins', id, parent, side: 'R', content: char('f') });
      parent = id;
    }
    const fdoc = replay(emptyDoc(), forward);
    expect(visibleItems(fdoc).length).toBe(100_000);
    expect(buildIndex(fdoc).idAt(99_999)).toEqual({ replica: R.a, seq: 100_000 });

    const backward: Op[] = [{ t: 'ins', id: { replica: R.b, seq: 1 }, parent: ROOT.id, side: 'R', content: char('b') }];
    for (let i = 2; i <= 100_000; i++) {
      backward.push({ t: 'ins', id: { replica: R.b, seq: i }, parent: { replica: R.b, seq: i - 1 }, side: 'L', content: char('b') });
    }
    const bdoc = replay(emptyDoc(), backward);
    expect(visibleItems(bdoc).length).toBe(100_000);
    expect(idKey(nextInTraversal(bdoc, ROOT.id) as ItemId)).toBe(idKey({ replica: R.b, seq: 100_000 }));
  });
});
