// @vitest-environment jsdom
// s6.test.ts — the S6 binding: each mark, each block type and a soft break survive the local
// transaction → ops → remote transaction round trip between two editors (the F7 path in miniature),
// plus the denied path (a hostile remote `fmt` with an unknown mark is refused, nothing thrown, the
// document normalises) and the interrupted path (two editors format overlapping ranges at once and
// converge — the W-8 concurrent-formatting case and the §2.5 anomaly).

import { apply, canonicalString, emptyDoc, localInsert, visibleItems, type Op, type ReplicaId } from '@weft/crdt';
import { setBlockType, toggleMark } from 'prosemirror-commands';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { normalize } from '../../src/binding/normalize.ts';
import { schema } from '../../src/binding/schema.ts';
import { exchange, expectSynced, mount, MemoryHost, R, textOfPm, unmount, type Mounted } from './helpers.ts';

/** Two synced editors on one shared initial text. */
async function pair(text: string): Promise<[Mounted, Mounted]> {
  const a = mount(new MemoryHost(R.a));
  const b = mount(new MemoryHost(R.b));
  a.view.dispatch(a.view.state.tr.insertText(text, 1));
  await exchange(a.host, b.host);
  return [a, b];
}

const selectAll = (m: Mounted, to: number): void => m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, 1, to)));

describe('S6 mark round-trips', () => {
  for (const name of ['bold', 'italic', 'code'] as const) {
    it(`a ${name} mark applied on one editor appears on the other and both converge`, async () => {
      const [a, b] = await pair('word');
      selectAll(a, 5);
      toggleMark(schema.marks[name]!)(a.view.state, a.view.dispatch);
      await exchange(a.host, b.host);
      expect(a.view.state.doc.rangeHasMark(1, 5, schema.marks[name]!)).toBe(true);
      expect(b.view.state.doc.rangeHasMark(1, 5, schema.marks[name]!)).toBe(true);
      expect(canonicalString(a.host.doc)).toBe(canonicalString(b.host.doc));
      expectSynced(a);
      expectSynced(b);
      unmount(a);
      unmount(b);
    });
  }

  it('a link mark carries its href across', async () => {
    const [a, b] = await pair('link');
    selectAll(a, 5);
    a.view.dispatch(a.view.state.tr.addMark(1, 5, schema.marks.link!.create({ href: 'https://example.test/x' })));
    await exchange(a.host, b.host);
    const linkOnB = b.view.state.doc.resolve(2).marks().find((x) => x.type === schema.marks.link);
    expect(linkOnB?.attrs.href).toBe('https://example.test/x');
    expect(canonicalString(a.host.doc)).toBe(canonicalString(b.host.doc));
    unmount(a);
    unmount(b);
  });
});

describe('S6 block-type round-trips', () => {
  for (const [name, level] of [['heading', 2], ['bullet_item', null], ['quote', null]] as const) {
    it(`a ${name} set on one editor appears on the other and both converge`, async () => {
      const [a, b] = await pair('block');
      selectAll(a, 6);
      setBlockType(schema.nodes[name]!, level === null ? null : { level })(a.view.state, a.view.dispatch);
      await exchange(a.host, b.host);
      expect(b.view.state.doc.firstChild?.type.name).toBe(name);
      if (level !== null) expect(b.view.state.doc.firstChild?.attrs.level).toBe(level);
      expect(canonicalString(a.host.doc)).toBe(canonicalString(b.host.doc));
      unmount(a);
      unmount(b);
    });
  }
});

describe('S6 soft break round-trip', () => {
  it('a hard_break inserted on one editor appears on the other as a hard_break and both converge', async () => {
    const [a, b] = await pair('ab');
    a.view.dispatch(a.view.state.tr.setSelection(TextSelection.create(a.view.state.doc, 2)));
    a.view.dispatch(a.view.state.tr.replaceSelectionWith(schema.nodes.hard_break!.create()));
    await exchange(a.host, b.host);
    let breaks = 0;
    b.view.state.doc.descendants((n) => {
      if (n.type.name === 'hard_break') breaks += 1;
    });
    expect(breaks).toBe(1);
    expect(textOfPm(b.view.state.doc)).toBe('a b');
    expect(canonicalString(a.host.doc)).toBe(canonicalString(b.host.doc));
    unmount(a);
    unmount(b);
  });
});

describe('S6 denied path', () => {
  it('a remote fmt naming a mark the schema does not know is refused by apply, nothing thrown, and the document still normalises', () => {
    let doc = emptyDoc();
    const me = R.a as ReplicaId;
    doc = localInsert(doc, me, 1, 0, { kind: 'char', text: 'x' }).doc;
    const hostile = { t: 'fmt', id: { replica: R.b, seq: 1 }, targets: [{ replica: me, seq: 1 }], mark: 'blink', active: true, lamport: 1 } as unknown as Op;
    const r = apply(doc, hostile);
    expect(r.kind).toBe('rejected');
    expect(canonicalString(r.doc)).toBe(canonicalString(doc)); // unchanged
    expect(() => normalize(visibleItems(r.doc))).not.toThrow();
  });
});

describe('S6 interrupted path (W-8 concurrent formatting)', () => {
  it('two editors bold overlapping ranges of the same word at once and converge to the same rendered marks', async () => {
    const [a, b] = await pair('abcdef');
    a.view.dispatch(a.view.state.tr.setSelection(TextSelection.create(a.view.state.doc, 1, 4))); // abc
    toggleMark(schema.marks.bold!)(a.view.state, a.view.dispatch);
    b.view.dispatch(b.view.state.tr.setSelection(TextSelection.create(b.view.state.doc, 3, 7))); // cdef
    toggleMark(schema.marks.bold!)(b.view.state, b.view.dispatch);
    await exchange(a.host, b.host);
    await exchange(a.host, b.host);
    expect(canonicalString(a.host.doc)).toBe(canonicalString(b.host.doc));
    expect(a.view.state.doc.eq(b.view.state.doc)).toBe(true);
    // The union abcdef is bold on both.
    expect(a.view.state.doc.rangeHasMark(1, 7, schema.marks.bold!)).toBe(true);
    unmount(a);
    unmount(b);
  });

  it('the §2.5 anomaly: a character typed just after a bolded word is not bold, and both editors converge', async () => {
    const [a, b] = await pair('Hello');
    selectAll(a, 6);
    toggleMark(schema.marks.bold!)(a.view.state, a.view.dispatch);
    // Type "!" right after the bold "o": ProseMirror inherits the stored bold mark, the CRDT does not.
    a.view.dispatch(a.view.state.tr.setSelection(TextSelection.create(a.view.state.doc, 6)));
    a.view.dispatch(a.view.state.tr.insertText('!', 6));
    await exchange(a.host, b.host);
    expect(a.view.state.doc.rangeHasMark(6, 7, schema.marks.bold!)).toBe(false); // the "!" is not bold
    expect(a.view.state.doc.rangeHasMark(1, 6, schema.marks.bold!)).toBe(true); // "Hello" still is
    expect(canonicalString(a.host.doc)).toBe(canonicalString(b.host.doc));
    unmount(a);
    unmount(b);
  });
});
