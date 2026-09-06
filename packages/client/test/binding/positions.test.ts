// positions.test.ts — the offset formula of positions.ts. Property: for random documents whose
// text mixes ASCII, an astral clef and an emoji ZWJ sequence (each code point one item, some two
// UTF-16 units), the PM ↔ visible maps are inverses on every cursor position and every visible
// index; the between-block positions are total and land on a real cursor. Anchors: a cursor
// anchored to an item survives random concurrent inserts and deletes on another replica, and one
// anchored to an item that peer deleted lands beside the text that remains.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildIndex, emptyDoc, localDelete, localInsert, visibleItems, type Doc, type ItemId, type ReplicaId } from '@weft/crdt';
import { normalize } from '../../src/binding/normalize.ts';
import { anchorFromVisible, pmPosToVisible, tokensInRange, visibleFromAnchor, visibleToPmPos } from '../../src/binding/positions.ts';
import { schema } from '../../src/binding/schema.ts';
import { codePoints, tokensOfPm } from '../../src/binding/tokens.ts';
import { numRuns, R, textPositions } from './helpers.ts';

/** A ZWJ family emoji spelled out: five code points, seven UTF-16 units, one glyph. */
const FAMILY = ['\u{1F468}', '‍', '\u{1F469}', '‍', '\u{1F467}'];
const ALPHABET = ['a', 'b', ' ', '𝄞', 'é', ...FAMILY];
const arbText = fc.array(fc.constantFrom(...ALPHABET), { maxLength: 12 }).map((cs) => cs.join(''));
const arbBlock = fc.record({ type: fc.constantFrom('paragraph', 'heading', 'bullet_item', 'quote'), text: arbText });
const arbDoc = fc.array(arbBlock, { minLength: 1, maxLength: 6 }).map((blocks) =>
  schema.node(
    'doc',
    null,
    blocks.map((b) => schema.node(b.type, b.type === 'heading' ? { level: 2 } : null, b.text === '' ? [] : [schema.text(b.text)])),
  ),
);

describe('PM position ↔ visible index', () => {
  it('are inverses on every cursor position and every visible index, counting code points not UTF-16 units', () => {
    fc.assert(
      fc.property(arbDoc, (doc) => {
        let length = -1;
        doc.forEach((block) => (length += codePoints(block.textContent) + 1));
        for (const pos of textPositions(doc)) expect(visibleToPmPos(doc, pmPosToVisible(doc, pos))).toBe(pos);
        for (let v = 0; v <= length; v++) expect(pmPosToVisible(doc, visibleToPmPos(doc, v))).toBe(v);
        expect(() => visibleToPmPos(doc, length + 1)).toThrow(RangeError);
      }),
      { numRuns: numRuns(false) },
    );
  });

  it('maps a position between two blocks to the start of the next block, and the end of the document to its last index', () => {
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('a𝄞')]), schema.node('paragraph', null, [schema.text('b')])]);
    // positions: 0 <p> 1 a 2 𝄞 4 </p> 5 <p> 6 b 7 </p> 8
    expect(pmPosToVisible(doc, 0)).toBe(0);
    expect(pmPosToVisible(doc, 4)).toBe(2);
    expect(pmPosToVisible(doc, 5)).toBe(3);
    expect(pmPosToVisible(doc, 6)).toBe(3);
    expect(pmPosToVisible(doc, 8)).toBe(4);
    expect(visibleToPmPos(doc, 2)).toBe(4);
    expect(visibleToPmPos(doc, 3)).toBe(6);
    expect(visibleToPmPos(doc, 4)).toBe(7);
  });

  it('refuses a negative or fractional visible index as a programmer error', () => {
    const doc = normalize([]);
    expect(() => visibleToPmPos(doc, -1)).toThrow(RangeError);
    expect(() => visibleToPmPos(doc, 0.5)).toThrow(RangeError);
    expect(() => anchorFromVisible(buildIndex(emptyDoc()), 1)).toThrow(RangeError);
  });

  it('refuses a fractional or out-of-range PM position as a RangeError, and rounds a position inside a surrogate pair up to the index after it (finding 17)', () => {
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('a𝄞b')])]);
    // positions: 0 <p> 1 a 2 𝄞 4 b 5 </p> 6 — position 3 is between the two UTF-16 units of the clef
    expect(() => pmPosToVisible(doc, 1.5)).toThrow(RangeError);
    expect(() => pmPosToVisible(doc, -1)).toThrow(RangeError);
    expect(() => pmPosToVisible(doc, 7)).toThrow(RangeError);
    expect(pmPosToVisible(doc, 2)).toBe(1);
    expect(pmPosToVisible(doc, 3)).toBe(2);
    expect(pmPosToVisible(doc, 4)).toBe(2);
  });
});

describe('tokens of a PM range', () => {
  // 0 <p> 1 ab 3 </p> 4 <h2> 5 𝄞 7 </h2> 8 <p> 9 c 10 </p> 11
  const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('ab')]), schema.node('heading', { level: 2 }, [schema.text('𝄞')]), schema.node('paragraph', null, [schema.text('c')])]);
  const kinds = (from: number, to: number): string[] => tokensInRange(doc, from, to).map((t) => (t.kind === 'char' ? t.text : t.kind === 'break' ? '⏎' : `▮${t.attrs.type}${t.attrs.level ?? ''}`));

  it('covers the code points inside the range and the boundary of every non-trailing block whose end the range reaches', () => {
    expect(kinds(1, 1)).toEqual([]); // a cursor mid-block: nothing
    expect(kinds(2, 2)).toEqual([]);
    expect(kinds(3, 3)).toEqual(['▮paragraph']); // the end of block 0 is its boundary
    expect(kinds(1, 3)).toEqual(['a', 'b', '▮paragraph']);
    expect(kinds(2, 5)).toEqual(['b', '▮paragraph']); // to the start of the heading, none of its text
    expect(kinds(2, 7)).toEqual(['b', '▮paragraph', '𝄞', '▮heading2']);
    expect(kinds(4, 8)).toEqual(['𝄞', '▮heading2']); // setNodeMarkup's range: the block and its boundary
    expect(kinds(9, 10)).toEqual(['c']); // the trailing block has no boundary token
    expect(kinds(0, 11)).toEqual(['a', 'b', '▮paragraph', '𝄞', '▮heading2', 'c']);
    expect(kinds(0, 11)).toEqual(tokensOfPm(doc).map((t) => (t.kind === 'char' ? t.text : t.kind === 'break' ? '⏎' : `▮${t.attrs.type}${t.attrs.level ?? ''}`)));
  });

  it('starts at the token pmPosToVisible names for the range’s start, for every cursor position and every position between blocks; past the last token both name the end', () => {
    const all = tokensOfPm(doc);
    // Every position a browser can produce: inside blocks by code point (never between the two units of the clef), and between blocks.
    const positions = [...textPositions(doc), 0, 4, 8, doc.content.size];
    for (const pos of positions) {
      const tokens = tokensInRange(doc, pos, doc.content.size);
      expect(tokens).toEqual(all.slice(all.length - tokens.length));
      expect(pmPosToVisible(doc, pos)).toBe(tokens.length > 0 ? all.length - tokens.length : all.length);
    }
    expect(() => tokensInRange(doc, 5, 4)).toThrow(RangeError);
  });
});

/** Random own edits on one replica: type or delete at a random index, against the doc as it is. */
const arbEdits = fc.array(fc.record({ at: fc.nat({ max: 200 }), text: fc.constantFrom('x', '𝄞', ''), del: fc.nat({ max: 3 }) }), { maxLength: 20 });

function edit(doc: Doc, me: ReplicaId, seq: { n: number }, e: { at: number; text: string; del: number }): Doc {
  const length = visibleItems(doc).length;
  if (e.text !== '') {
    const step = localInsert(doc, me, ++seq.n, e.at % (length + 1), { kind: 'char', text: e.text });
    return step.doc;
  }
  if (length === 0 || e.del === 0) return doc;
  const from = e.at % length;
  const step = localDelete(doc, me, seq.n + 1, from, Math.min(length, from + e.del));
  seq.n += step.ops.length;
  return step.doc;
}

describe('item anchors', () => {
  it('survive concurrent edits: after a peer inserts and deletes anywhere, the anchor still resolves to a valid index beside the same item', () => {
    fc.assert(
      fc.property(arbEdits, fc.nat({ max: 200 }), arbEdits, (mine, cursor, theirs) => {
        const seqA = { n: 0 };
        let doc = emptyDoc();
        for (const e of mine) doc = edit(doc, R.a, seqA, e);
        const before = buildIndex(doc);
        const at = cursor % (before.length + 1);
        const anchor = anchorFromVisible(before, at);
        expect(visibleFromAnchor(before, anchor)).toBe(at);
        const seqB = { n: 0 };
        for (const e of theirs) doc = edit(doc, R.b, seqB, e);
        const after = buildIndex(doc);
        const resolved = visibleFromAnchor(after, anchor);
        expect(resolved).toBeGreaterThanOrEqual(0);
        expect(resolved).toBeLessThanOrEqual(after.length);
        if (anchor.id !== null && after.indexOf(anchor.id) >= 0) {
          expect(resolved).toBe(after.indexOf(anchor.id) + (anchor.side === 'after' ? 1 : 0));
        }
      }),
      { numRuns: numRuns(false) },
    );
  });

  it('clamps to a live neighbour when the anchored item was deleted, and to 0 for an empty document or an id never received', () => {
    const seq = { n: 0 };
    let doc = emptyDoc();
    for (const ch of 'abc') doc = edit(doc, R.a, seq, { at: seq.n, text: ch, del: 0 });
    const index = buildIndex(doc);
    const afterB = anchorFromVisible(index, 2);
    expect(afterB).toEqual({ id: { replica: R.a, seq: 2 }, side: 'after' });
    doc = localDelete(doc, R.b, 1, 1, 2).doc; // a peer deletes "b"
    const after = buildIndex(doc);
    expect(visibleFromAnchor(after, afterB)).toBe(1); // between a and c, where b was
    expect(visibleFromAnchor(after, { id: { replica: R.a, seq: 2 }, side: 'before' })).toBe(1);
    expect(visibleFromAnchor(after, { id: null, side: 'before' })).toBe(0);
    expect(visibleFromAnchor(after, { id: null, side: 'after' })).toBe(0);
    const unknown: ItemId = { replica: R.b, seq: 99 };
    expect(visibleFromAnchor(after, { id: unknown, side: 'after' })).toBe(0);
    expect(anchorFromVisible(buildIndex(emptyDoc()), 0)).toEqual({ id: null, side: 'after' });
  });

  it('anchors index 0 after ROOT, not before the first item: a peer inserting at 0 lands after the cursor, exactly as at any other index (finding P5)', () => {
    const seq = { n: 0 };
    let doc = emptyDoc();
    for (const ch of 'ab') doc = edit(doc, R.a, seq, { at: seq.n, text: ch, del: 0 });
    const before = buildIndex(doc);
    const at0 = anchorFromVisible(before, 0);
    const at1 = anchorFromVisible(before, 1);
    expect(at0).toEqual({ id: null, side: 'after' });
    doc = localInsert(doc, R.b, 1, 0, { kind: 'char', text: 'Z' }).doc; // a peer inserts at 0
    doc = localInsert(doc, R.b, 2, 2, { kind: 'char', text: 'Q' }).doc; // and right after "a"
    const after = buildIndex(doc);
    expect(visibleFromAnchor(after, at0)).toBe(0); // Z landed after the cursor at 0 …
    expect(visibleFromAnchor(after, at1)).toBe(2); // … as Q landed after the cursor at 1
  });
});
