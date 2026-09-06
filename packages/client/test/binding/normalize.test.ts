// normalize.test.ts — every sequence the CRDT can express maps to exactly one schema-valid
// document. Examples pin the rules of design §5.3 (empty doc, boundary-only doc, two boundaries in
// a row, a heading level on a bullet, a heading without a level); the property throws random
// sequences of chars and boundaries with random — including invalid — attrs at it and checks the
// result validates, is deterministic, and reads back as the same tokens.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { apply, emptyDoc, localInsert, localSetBlock, ROOT, visibleItems, type BlockAttrs, type Doc, type Item, type Op, type ReplicaId } from '@weft/crdt';
import { normalize } from '../../src/binding/normalize.ts';
import { normalizeAttrs, tokensOfItems, tokensOfPm } from '../../src/binding/tokens.ts';
import { numRuns, R, textOfItems, textOfPm } from './helpers.ts';

const item = (content: Item['content'], seq: number): Item => ({ id: { replica: R.a, seq }, parent: ROOT.id, side: 'R', content, deleted: false, marks: {} });
const ch = (text: string, seq: number): Item => item({ kind: 'char', text }, seq);
const block = (attrs: BlockAttrs, seq: number): Item => item({ kind: 'block', attrs, lamport: 0, replica: R.a, seq }, seq);
const blockTypes = (doc: ReturnType<typeof normalize>): string[] => {
  const out: string[] = [];
  doc.forEach((b) => out.push(b.type.name + (b.type.name === 'heading' ? b.attrs.level : '')));
  return out;
};

describe('normalize', () => {
  it('turns the empty sequence into one empty paragraph, never an empty document', () => {
    const doc = normalize([]);
    expect(() => doc.check()).not.toThrow();
    expect(blockTypes(doc)).toEqual(['paragraph']);
    expect(doc.textContent).toBe('');
  });

  it('turns a boundary-only sequence into two empty paragraphs, and two boundaries in a row into an empty paragraph between', () => {
    expect(blockTypes(normalize([block({ type: 'paragraph' }, 1)]))).toEqual(['paragraph', 'paragraph']);
    const doc = normalize([ch('a', 1), block({ type: 'quote' }, 2), block({ type: 'paragraph' }, 3), ch('b', 4)]);
    expect(blockTypes(doc)).toEqual(['quote', 'paragraph', 'paragraph']);
    expect(textOfPm(doc)).toBe('a\n\nb');
  });

  it('ignores a heading level on a non-heading and gives a heading without a level its first level', () => {
    const doc = normalize([ch('a', 1), block({ type: 'bullet', level: 2 }, 2), ch('b', 3), block({ type: 'heading' }, 4), ch('c', 5), block({ type: 'heading', level: 3 }, 6)]);
    expect(blockTypes(doc)).toEqual(['bullet_item', 'heading1', 'heading3', 'paragraph']);
    expect(doc.child(0).attrs).toEqual({});
  });

  it('closes the trailing block as a paragraph, because the root sentinel is one', () => {
    const doc = normalize([block({ type: 'heading', level: 1 }, 1), ch('x', 2)]);
    expect(blockTypes(doc)).toEqual(['heading1', 'paragraph']);
    expect(normalizeAttrs({ type: 'heading' })).toEqual({ type: 'heading', level: 1 });
    expect(normalizeAttrs({ type: 'quote', level: 3 })).toEqual({ type: 'quote' });
  });

  const arbAttrs = fc.record({ type: fc.constantFrom<BlockAttrs['type']>('paragraph', 'heading', 'bullet', 'quote'), level: fc.option(fc.constantFrom(1, 2, 3) as fc.Arbitrary<1 | 2 | 3>, { nil: undefined }) }).map(
    (a): BlockAttrs => (a.level === undefined ? { type: a.type } : { type: a.type, level: a.level }),
  );
  const arbItems = fc
    .array(fc.oneof({ weight: 3, arbitrary: fc.constantFrom('a', ' ', '𝄞').map((t) => ({ kind: 'char' as const, text: t })) }, { weight: 1, arbitrary: arbAttrs.map((attrs) => ({ kind: 'block' as const, attrs })) }), { maxLength: 30 })
    .map((contents) => contents.map((c, i) => (c.kind === 'char' ? ch(c.text, i + 1) : block(c.attrs, i + 1))));

  it('is total and deterministic over random sequences with any attrs, and the result reads back as the same normalised tokens', () => {
    fc.assert(
      fc.property(arbItems, (items) => {
        const doc = normalize(items);
        expect(() => doc.check()).not.toThrow();
        expect(doc.eq(normalize(items))).toBe(true);
        expect(tokensOfPm(doc)).toEqual(tokensOfItems(items));
        expect(textOfPm(doc)).toBe(textOfItems(items));
      }),
      { numRuns: numRuns(false) },
    );
  });

  it('denied: a remote `blk` that puts a heading level on a quote is applied by the CRDT and still normalises to a valid doc without throwing', () => {
    const me: ReplicaId = R.b;
    let doc: Doc = emptyDoc();
    doc = localInsert(doc, me, 1, 0, { kind: 'char', text: 'q' }).doc;
    doc = localInsert(doc, me, 2, 1, { kind: 'block', attrs: { type: 'paragraph' }, lamport: 0, replica: me }).doc;
    doc = localSetBlock(doc, me, 3, 0, { type: 'quote', level: 3 }).doc;
    const remote: Op = { t: 'blk', id: { replica: R.a, seq: 1 }, target: { replica: me, seq: 2 }, attrs: { type: 'bullet', level: 1 }, lamport: 5 };
    const r = apply(doc, remote);
    expect(r.kind).toBe('applied');
    const normal = normalize(visibleItems(r.doc));
    expect(() => normal.check()).not.toThrow();
    expect(blockTypes(normal)).toEqual(['bullet_item', 'paragraph']);
  });
});
