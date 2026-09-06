// positionIndex.test.ts — the incremental PositionIndex (E47) is indistinguishable from a fresh
// build. Property: a random script of LOCAL inserts (single and runs), deletes and block-type
// changes, each performed through the `At` variants of local.ts and mirrored into the index with
// `withInserted` / `withDeleted` / `withItem`, agrees with `buildIndex` of the same doc on every
// query after every step — length, items, idAt, indexOf and visibleBefore for every item tombstones
// included, blockRanges, neighboursAt for every index — and the `At` variants emit the very ops the
// traversal-based functions emit. Deriving leaves the parent index answering as before (it is a
// value). `blockRangeAt` tiles the document. And the costs the binding depends on are printed.
import fc from 'fast-check';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  apply,
  blockRangeAt,
  buildIndex,
  emptyDoc,
  localDelete,
  localDeleteAt,
  localInsert,
  localInsertAt,
  localSetBlock,
  localSetBlockAt,
  neighboursAt,
  ROOT,
  ROOT_ATTRS,
  traversalOrder,
  visibleItems,
  type BlockAttrs,
  type Doc,
  type Op,
  type PositionIndex,
} from '../src/index.ts';
import { arbBlockAttrs, type IntentContent } from './generators.ts';
import { char, block, brk, numRuns, R } from './helpers.ts';

type Step = { kind: 'insert'; at: number; contents: IntentContent[] } | { kind: 'delete'; from: number; count: number } | { kind: 'setBlock'; at: number; attrs: BlockAttrs };

const arbContent: fc.Arbitrary<IntentContent> = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom('a', 'b', '𝄞', ' ').map((text) => ({ kind: 'char' as const, text })) },
  { weight: 1, arbitrary: arbBlockAttrs.map((attrs) => ({ kind: 'block' as const, attrs })) },
  { weight: 1, arbitrary: fc.constant({ kind: 'break' as const }) },
);
const arbStep: fc.Arbitrary<Step> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('insert' as const), at: fc.nat({ max: 200 }), contents: fc.array(arbContent, { minLength: 1, maxLength: 5 }) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('delete' as const), from: fc.nat({ max: 200 }), count: fc.nat({ max: 4 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('setBlock' as const), at: fc.nat({ max: 200 }), attrs: arbBlockAttrs }) },
);

const asContent = (c: IntentContent) => (c.kind === 'char' ? char(c.text) : c.kind === 'break' ? brk() : block(c.attrs, R.a));

/** One replica whose index is carried incrementally, with the same edit also run through the traversal-based function to compare ops. */
class Carried {
  doc: Doc = emptyDoc();
  index: PositionIndex = buildIndex(this.doc);
  seq = 0;

  insert(at: number, contents: readonly IntentContent[]): void {
    const v = at % (this.index.length + 1);
    const first = asContent(contents[0] as IntentContent);
    const viaIndex = localInsertAt(this.doc, this.index, R.a, this.seq + 1, v, first);
    const viaTraversal = localInsert(this.doc, R.a, this.seq + 1, v, first);
    expect(viaIndex.ops).toEqual(viaTraversal.ops);
    const ops: Op[] = [...viaIndex.ops];
    let cur = viaIndex.doc;
    let parent = (ops[0] as Op).id;
    for (let k = 1; k < contents.length; k++) {
      const op: Op = { t: 'ins', id: { replica: R.a, seq: this.seq + 1 + k }, parent, side: 'R', content: asContent(contents[k] as IntentContent) };
      cur = apply(cur, op).doc;
      ops.push(op);
      parent = op.id;
    }
    this.seq += ops.length;
    this.doc = cur;
    this.index = this.index.withInserted(
      cur,
      v,
      ops.map((op) => op.id),
    );
  }

  delete(from: number, count: number): void {
    if (this.index.length === 0) return;
    const f = from % this.index.length;
    const t = Math.min(this.index.length, f + count);
    const viaIndex = localDeleteAt(this.doc, this.index, R.a, this.seq + 1, f, t);
    expect(viaIndex.ops).toEqual(localDelete(this.doc, R.a, this.seq + 1, f, t).ops);
    this.seq += viaIndex.ops.length;
    this.doc = viaIndex.doc;
    this.index = this.index.withDeleted(this.doc, f, t);
  }

  setBlock(at: number, attrs: BlockAttrs): void {
    const v = at % (this.index.length + 1);
    const range = blockRangeAt(this.index, v);
    if (range.boundary === ROOT.id) {
      expect(() => localSetBlockAt(this.doc, this.index, R.a, this.seq + 1, v, attrs)).toThrow(RangeError);
      return;
    }
    const viaIndex = localSetBlockAt(this.doc, this.index, R.a, this.seq + 1, v, attrs);
    expect(viaIndex.ops).toEqual(localSetBlock(this.doc, R.a, this.seq + 1, v, attrs).ops);
    this.seq += 1;
    this.doc = viaIndex.doc;
    this.index = this.index.withItem(this.doc, range.to);
  }
}

/** Every observable of `index` equals the fresh build's. */
function expectSameAsFresh(index: PositionIndex, doc: Doc): void {
  const fresh = buildIndex(doc);
  const visible = visibleItems(doc);
  expect(index.length).toBe(fresh.length);
  expect(index.items()).toEqual(visible);
  for (let v = 0; v <= visible.length; v++) {
    expect(index.idAt(v)).toEqual(fresh.idAt(v));
    expect(index.itemAt(v)).toEqual(fresh.itemAt(v));
    expect(index.neighboursAt(v)).toEqual(neighboursAt(doc, v));
  }
  for (const item of traversalOrder(doc)) {
    expect(index.indexOf(item.id)).toBe(fresh.indexOf(item.id));
    expect(index.visibleBefore(item.id)).toBe(fresh.visibleBefore(item.id));
  }
  expect(index.indexOf({ replica: R.d, seq: 7 })).toBe(-1);
  expect(index.visibleBefore({ replica: R.d, seq: 7 })).toBe(-1);
  expect(index.blockRanges()).toEqual(fresh.blockRanges());
}

describe('the incremental index (E47)', () => {
  it('agrees with buildIndex on every query after every local insert, delete and block change, and the At variants emit the traversal’s ops', () => {
    fc.assert(
      fc.property(fc.array(arbStep, { maxLength: 40 }), (script) => {
        const rep = new Carried();
        for (const step of script) {
          if (step.kind === 'insert') rep.insert(step.at, step.contents);
          else if (step.kind === 'delete') rep.delete(step.from, step.count);
          else rep.setBlock(step.at, step.attrs);
          expectSameAsFresh(rep.index, rep.doc);
        }
      }),
      { numRuns: numRuns('light') },
    );
  });

  it('is a value: deriving from an index leaves it answering as before, and two derivations from one parent do not see each other', () => {
    const rep = new Carried();
    rep.insert(0, [{ kind: 'char', text: 'a' }, { kind: 'char', text: 'b' }, { kind: 'block', attrs: { type: 'quote' } }, { kind: 'char', text: 'c' }]);
    const parent = rep.index;
    const parentDoc = rep.doc;
    // Two branches off one parent, by two authors so both are the author's next seq.
    const x = localInsertAt(parentDoc, parent, R.b, 1, 1, char('x'));
    const y = localInsertAt(parentDoc, parent, R.c, 1, 3, char('y'));
    const withX = parent.withInserted(x.doc, 1, [{ replica: R.b, seq: 1 }]);
    const withY = parent.withInserted(y.doc, 3, [{ replica: R.c, seq: 1 }]);
    expectSameAsFresh(parent, parentDoc);
    expectSameAsFresh(withX, x.doc);
    expectSameAsFresh(withY, y.doc);
    expect(withX.indexOf({ replica: R.c, seq: 1 })).toBe(-1);
    expect(withY.indexOf({ replica: R.b, seq: 1 })).toBe(-1);
    const del = localDeleteAt(x.doc, withX, R.b, 2, 0, 2);
    const afterDel = withX.withDeleted(del.doc, 0, 2);
    expectSameAsFresh(withX, x.doc);
    expectSameAsFresh(afterDel, del.doc);
  });

  it('refuses a derivation that does not describe the doc: an index outside 0..length, a live item as deleted, a tombstone as inserted, an id the doc lacks', () => {
    const rep = new Carried();
    rep.insert(0, [{ kind: 'char', text: 'a' }, { kind: 'char', text: 'b' }]);
    expect(() => rep.index.withInserted(rep.doc, 3, [])).toThrow(RangeError);
    expect(() => rep.index.withDeleted(rep.doc, 0, 1)).toThrow(RangeError); // still live
    expect(() => rep.index.withInserted(rep.doc, 0, [{ replica: R.b, seq: 1 }])).toThrow(RangeError); // not in the doc
    const del = localDeleteAt(rep.doc, rep.index, R.a, 3, 0, 1);
    expect(() => rep.index.withInserted(del.doc, 1, [{ replica: R.a, seq: 1 }])).toThrow(RangeError); // a tombstone
    expect(() => rep.index.withItem(del.doc, 0)).toThrow(RangeError);
    expect(() => rep.index.neighboursAt(3)).toThrow(RangeError);
    expect(() => rep.index.neighboursAt(0.5)).toThrow(RangeError);
    expect(rep.index.withInserted(rep.doc, 0, [])).toBe(rep.index);
    expect(rep.index.withDeleted(rep.doc, 1, 1)).toBe(rep.index);
  });

  it('blockRangeAt tiles 0..length, names ROOT for the trailing block, and refuses an index outside', () => {
    const rep = new Carried();
    rep.insert(0, [{ kind: 'char', text: 'a' }, { kind: 'block', attrs: { type: 'heading', level: 2 } }, { kind: 'char', text: 'b' }, { kind: 'block', attrs: { type: 'bullet' } }]);
    const ranges = rep.index.blockRanges();
    expect(ranges).toHaveLength(3);
    for (let v = 0; v <= rep.index.length; v++) {
      const r = blockRangeAt(rep.index, v);
      expect(r.from <= v && v <= r.to).toBe(true);
      expect(ranges).toContain(r);
    }
    expect(blockRangeAt(rep.index, rep.index.length)).toMatchObject({ boundary: ROOT.id, attrs: ROOT_ATTRS });
    expect(() => blockRangeAt(rep.index, rep.index.length + 1)).toThrow(RangeError);
    expect(() => blockRangeAt(rep.index, -1)).toThrow(RangeError);
  });

  it('costs: a derivation on a 50 000-character document is a few memcpys, not a traversal (printed, budgeted loosely)', () => {
    let doc = emptyDoc();
    const first = localInsert(doc, R.a, 1, 0, char('a'));
    doc = first.doc;
    let parent = (first.ops[0] as Op).id;
    for (let k = 1; k < 50_000; k++) {
      const op: Op = { t: 'ins', id: { replica: R.a, seq: k + 1 }, parent, side: 'R', content: char('b') };
      doc = apply(doc, op).doc;
      parent = op.id;
    }
    const t0 = performance.now();
    const index = buildIndex(doc);
    const built = performance.now() - t0;
    const t1 = performance.now();
    const ins = localInsertAt(doc, index, R.a, 50_001, 1, char('x'));
    const derived = index.withInserted(ins.doc, 1, [{ replica: R.a, seq: 50_001 }]);
    const derive = performance.now() - t1;
    const t2 = performance.now();
    const del = localDeleteAt(ins.doc, derived, R.a, 50_002, 0, 1);
    const derived2 = derived.withDeleted(del.doc, 0, 1);
    const derive2 = performance.now() - t2;
    console.log(`50 000 items: buildIndex ${built.toFixed(1)} ms · localInsertAt + withInserted at 1: ${derive.toFixed(2)} ms · localDeleteAt + withDeleted at 0: ${derive2.toFixed(2)} ms`);
    expect(derived2.length).toBe(50_000);
    expect(derive).toBeLessThan(built);
    expect(derived2.idAt(0)).toEqual({ replica: R.a, seq: 50_001 }); // "a" went, the inserted "x" leads
    expect(derived2.neighboursAt(50_000)).toEqual(neighboursAt(del.doc, 50_000));
  });
});
