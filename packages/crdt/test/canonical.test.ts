// canonical.test.ts — canonicalBytes is the equality every property test rests on. It must be a
// function of the visible sequence alone: Map insertion order, tombstones and inactive marks must
// not leak into it, and it must be an array of tuples, never an object.
import { describe, expect, it } from 'vitest';
import { canonicalBytes, canonicalString, emptyDoc, idKey, ROOT, type Doc, type Item, type Op } from '../src/index.ts';
import { appliedAll, block, char, id, ins, R, Replica } from './helpers.ts';

describe('canonicalBytes', () => {
  it('is an empty JSON array for an empty doc and UTF-8 bytes of a JSON array otherwise', () => {
    expect(canonicalString(emptyDoc())).toBe('[]');
    const rep = new Replica(R.a);
    rep.type(0, 'a𝄞');
    const s = canonicalString(rep.doc);
    expect(JSON.parse(s)).toEqual([['a', []], ['𝄞', []]]);
    expect(canonicalBytes(rep.doc)).toEqual(new TextEncoder().encode(s));
  });

  it('encodes a block boundary as ["block", type, level | null], active marks sorted by name, and the href of an active link', () => {
    const rep = new Replica(R.a);
    rep.type(0, 'ab');
    rep.insert(2, block({ type: 'heading', level: 2 }, R.a));
    rep.insert(3, block({ type: 'bullet' }, R.a));
    rep.format(0, 1, 'link', true, 'https://weft.test/');
    rep.format(0, 2, 'italic', true);
    rep.format(0, 2, 'bold', true);
    rep.format(1, 2, 'bold', false);
    expect(JSON.parse(canonicalString(rep.doc))).toEqual([
      ['a', ['bold', 'italic', 'link'], 'https://weft.test/'],
      ['b', ['italic']],
      [['block', 'heading', 2], []],
      [['block', 'bullet', null], []],
    ]);
  });

  it('is identical for two docs whose Maps were filled in different insertion orders', () => {
    const ops: Op[] = [ins(id(R.a, 1), ROOT.id, 'R', char('x')), ins(id(R.b, 1), id(R.a, 1), 'R', char('y')), ins(id(R.c, 1), id(R.a, 1), 'L', char('w'))];
    const real = appliedAll(emptyDoc(), ops);
    // A hand-built Doc with plain Maps, entries inserted in the reverse order and children in a different shape.
    const entries = [...real.items.entries()].reverse();
    const childEntries = [...real.children.entries()].reverse();
    const reordered: Doc = {
      items: new Map<string, Item>(entries),
      children: new Map(childEntries),
      sv: real.sv,
      pending: new Map(),
      formatLamport: 0,
    };
    expect([...reordered.items.keys()]).not.toEqual([...real.items.keys()]);
    expect(canonicalBytes(reordered)).toEqual(canonicalBytes(real));
    expect(canonicalString(real)).toBe('[["w",[]],["x",[]],["y",[]]]');
  });

  it('ignores tombstones and inactive marks', () => {
    const rep = new Replica(R.a);
    rep.type(0, 'abc');
    rep.format(0, 3, 'code', true);
    rep.format(0, 3, 'code', false);
    rep.delete(1, 2);
    expect(JSON.parse(canonicalString(rep.doc))).toEqual([['a', []], ['c', []]]);
    expect(rep.doc.items.get(idKey(id(R.a, 2)))?.deleted).toBe(true);
  });

  it('emits null for an active link without an href rather than dropping the slot', () => {
    const rep = new Replica(R.a);
    rep.type(0, 'a');
    const doc = appliedAll(rep.doc, [{ t: 'fmt', id: id(R.b, 1), targets: [id(R.a, 1)], mark: 'link', active: true, lamport: 1 }]);
    expect(JSON.parse(canonicalString(doc))).toEqual([['a', ['link'], null]]);
  });
});
