// @vitest-environment jsdom
// binding.test.ts — the two directions of the binding, one edit at a time, with I7 checked after
// each. Local: typing (ASCII and astral), Enter at the start, middle and end of a paragraph,
// Backspace at a block start, deleting a range across blocks, deleting everything, pasting several
// paragraphs — each names the ops it must produce. Remote: a peer's insert, delete and join arrive
// as one minimal transaction that keeps this editor's cursor beside the same text. Denied and
// interrupted paths: a remote op the schema cannot show is normalised; a remote change while a
// local one is in flight lands too; an IME composition defers the remote change until it ends; a
// host that cannot persist reports a fault and the editor shows what the CRDT holds.
import { visibleItems } from '@weft/crdt';
import { joinBackward, splitBlock } from 'prosemirror-commands';
import { TextSelection } from 'prosemirror-state';
import { afterEach, describe, expect, it } from 'vitest';
import { weftKey, type BindingFault } from '../../src/binding/plugin.ts';
import { pmPosToVisible } from '../../src/binding/positions.ts';
import { docChanges, exchange, expectMirror, expectSynced, MemoryHost, mount, pasteText, R, textOfPm, tick, unmount, type Mounted } from './helpers.ts';

const mounted: Mounted[] = [];
function editor(host = new MemoryHost(R.a)): Mounted {
  const m = mount(host);
  mounted.push(m);
  return m;
}
afterEach(() => {
  for (const m of mounted.splice(0)) unmount(m);
});

function type(m: Mounted, pos: number, text: string): void {
  m.view.dispatch(m.view.state.tr.insertText(text, pos));
}
function select(m: Mounted, anchor: number, head = anchor): void {
  m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, anchor, head)));
}
const opKinds = (m: Mounted, from = 0): string => m.host.log.slice(from).map((op) => (op.t === 'ins' ? (op.content.kind === 'char' ? op.content.text : '▮') : 'del')).join('');

describe('local edits become ops', () => {
  it('typing emits one insert per code point, an astral character included, and the mirror holds after each', () => {
    const m = editor();
    type(m, 1, 'a');
    type(m, 2, '𝄞');
    type(m, 4, 'b');
    expectSynced(m);
    expect(opKinds(m)).toBe('a𝄞b');
    expect(m.host.text()).toBe('a𝄞b');
  });

  it('Enter in the middle of a paragraph inserts one boundary carrying the paragraph attrs; at the start and end likewise', () => {
    const m = editor();
    type(m, 1, 'abcd');
    select(m, 3);
    expect(splitBlock(m.view.state, m.view.dispatch)).toBe(true);
    expectSynced(m);
    expect(textOfPm(m.view.state.doc)).toBe('ab\ncd');
    expect(m.host.log.at(-1)).toMatchObject({ t: 'ins', content: { kind: 'block', attrs: { type: 'paragraph' } } });
    select(m, 1);
    splitBlock(m.view.state, m.view.dispatch);
    select(m, m.view.state.doc.content.size - 1);
    splitBlock(m.view.state, m.view.dispatch);
    expectSynced(m);
    expect(textOfPm(m.view.state.doc)).toBe('\nab\ncd\n');
    expect(opKinds(m, 4)).toBe('▮▮▮');
  });

  it('Backspace at the start of a block deletes exactly the boundary before it', () => {
    const m = editor();
    type(m, 1, 'ab');
    select(m, 2);
    splitBlock(m.view.state, m.view.dispatch);
    type(m, 5, 'c');
    expect(textOfPm(m.view.state.doc)).toBe('a\nbc');
    select(m, 4);
    expect(joinBackward(m.view.state, m.view.dispatch)).toBe(true);
    expectSynced(m);
    expect(textOfPm(m.view.state.doc)).toBe('abc');
    expect(m.host.log.at(-1)).toMatchObject({ t: 'del', target: { replica: R.a, seq: 3 } });
  });

  it('deleting a range across blocks removes the characters and the boundaries between them, in document order', () => {
    const m = editor();
    type(m, 1, 'abc');
    select(m, 2);
    splitBlock(m.view.state, m.view.dispatch);
    select(m, 5);
    splitBlock(m.view.state, m.view.dispatch);
    expect(textOfPm(m.view.state.doc)).toBe('a\nb\nc');
    const before = m.host.log.length;
    m.view.dispatch(m.view.state.tr.deleteRange(2, 9));
    expectSynced(m);
    expect(textOfPm(m.view.state.doc)).toBe('a');
    expect(m.host.log.slice(before).map((op) => (op.t === 'del' ? op.target.seq : -1))).toEqual([4, 2, 5, 3]);
  });

  it('deleting everything leaves one empty paragraph on both sides', () => {
    const m = editor();
    type(m, 1, 'ab');
    select(m, 2);
    splitBlock(m.view.state, m.view.dispatch);
    m.view.dispatch(m.view.state.tr.delete(0, m.view.state.doc.content.size));
    expectSynced(m);
    expect(m.view.state.doc.childCount).toBe(1);
    expect(visibleItems(m.host.doc)).toEqual([]);
  });

  it('pasting three paragraphs of plain text is one transaction and many ops in document order, then the mirror holds', () => {
    const m = editor();
    type(m, 1, 'xy');
    select(m, 2);
    pasteText(m, 'one\ntwo\n𝄞');
    expectSynced(m);
    expect(textOfPm(m.view.state.doc)).toBe('xone\ntwo\n𝄞y');
    expect(opKinds(m, 2)).toBe('one▮two▮𝄞');
    expect(docChanges(m)).toHaveLength(2); // the typing and the paste — no correction was needed
  });

  it('a mark step over a selection becomes one fmt op, and the mark is kept and shown (S6)', () => {
    const m = editor();
    type(m, 1, 'ab');
    const before = m.host.log.length;
    m.view.dispatch(m.view.state.tr.addMark(1, 3, m.view.state.schema.marks.bold!.create()));
    // Exactly one fmt op for the range, and the editor keeps the bold — I7 holds with the mark present.
    const added = m.host.log.slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ t: 'fmt', mark: 'bold', active: true });
    expectSynced(m);
    expect(m.view.state.doc.rangeHasMark(1, 3, m.view.state.schema.marks.bold!)).toBe(true);
  });
});

describe('remote changes become transactions', () => {
  it('a peer typing into the paragraph I am in arrives as one inline transaction, and my cursor stays beside the same character', async () => {
    const a = editor(new MemoryHost(R.a));
    const b = editor(new MemoryHost(R.b));
    type(a, 1, 'ab');
    await exchange(a.host, b.host);
    expect(textOfPm(b.view.state.doc)).toBe('ab');
    select(a, 2); // between a and b
    type(b, 3, 'XYZ'); // after b
    type(b, 1, 'P'); // before a
    const n = a.dispatched.length;
    await exchange(a.host, b.host);
    expectSynced(a);
    expectSynced(b);
    expect(textOfPm(a.view.state.doc)).toBe('PabXYZ');
    expect(a.dispatched.length).toBe(n + 1);
    expect(a.view.state.selection.head).toBe(3); // still after a
  });

  it('a peer joining two blocks arrives as a block replacement, and my cursor lands beside the text I was in', async () => {
    const a = editor(new MemoryHost(R.a));
    const b = editor(new MemoryHost(R.b));
    type(a, 1, 'ab');
    select(a, 2);
    splitBlock(a.view.state, a.view.dispatch);
    type(a, 5, 'c'); // a | bc
    await exchange(a.host, b.host);
    select(a, 5); // between b and c
    select(b, 4);
    joinBackward(b.view.state, b.view.dispatch);
    await exchange(a.host, b.host);
    expectSynced(a);
    expect(textOfPm(a.view.state.doc)).toBe('abc');
    expect(a.view.state.selection.head).toBe(3);
  });

  it('denied: a remote boundary with a heading level on a bullet is shown as a bullet, and a heading without a level as h1', async () => {
    const a = editor(new MemoryHost(R.a));
    const me = R.b;
    a.host.receive([
      { t: 'ins', id: { replica: me, seq: 1 }, parent: { replica: 'aaaaaaaaaaaaa' as typeof me, seq: 0 }, side: 'R', content: { kind: 'char', text: 'x' } },
      { t: 'ins', id: { replica: me, seq: 2 }, parent: { replica: me, seq: 1 }, side: 'R', content: { kind: 'block', attrs: { type: 'bullet', level: 2 }, lamport: 0, replica: me } },
      { t: 'ins', id: { replica: me, seq: 3 }, parent: { replica: me, seq: 2 }, side: 'R', content: { kind: 'block', attrs: { type: 'heading' }, lamport: 0, replica: me } },
    ]);
    await tick();
    expectSynced(a);
    const types: string[] = [];
    a.view.state.doc.forEach((blk) => types.push(blk.type.name));
    expect(types).toEqual(['bullet_item', 'heading', 'paragraph']);
    expect(a.view.state.doc.child(1).attrs.level).toBe(1);
  });

  it('interrupted: a remote change that arrives while a local transaction is being built lands too, and I7 holds on both', async () => {
    const a = editor(new MemoryHost(R.a));
    const b = editor(new MemoryHost(R.b));
    type(a, 1, 'ab');
    await exchange(a.host, b.host);
    type(b, 3, 'Z');
    // b's op reaches a's host (the socket message) but a's editor has not synced yet — the sync is a microtask away —
    // and a types in the same tick.
    a.host.receive(b.host.pull());
    type(a, 2, 'M');
    expectMirror(a);
    await tick();
    expectSynced(a);
    expect(textOfPm(a.view.state.doc)).toBe('aMbZ');
    await exchange(a.host, b.host);
    expectSynced(b);
    expect(textOfPm(b.view.state.doc)).toBe('aMbZ');
  });

  it('interrupted: during an IME composition a remote change is deferred and applied on compositionend, and I7 holds', async () => {
    const a = editor(new MemoryHost(R.a));
    const b = editor(new MemoryHost(R.b));
    type(a, 1, 'ab');
    await exchange(a.host, b.host);
    a.view.dom.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    expect(a.view.composing).toBe(true);
    type(b, 3, 'Q');
    a.host.receive(b.host.pull());
    await tick();
    expect(textOfPm(a.view.state.doc)).toBe('ab'); // deferred
    expectMirror(a);
    type(a, 3, 'か'); // what the composition commits
    a.view.dom.dispatchEvent(new Event('compositionend', { bubbles: true }));
    await tick();
    await tick();
    expectSynced(a);
    expect(textOfPm(a.view.state.doc)).toBe('abかQ');
    await exchange(a.host, b.host);
    expect(textOfPm(b.view.state.doc)).toBe('abかQ');
    expectSynced(b);
  });

  it('a host notification with nothing new is a no-op transaction-wise', async () => {
    const a = editor();
    type(a, 1, 'a');
    const n = a.dispatched.length;
    a.host.receive([]);
    await tick();
    expect(a.dispatched.length).toBe(n);
  });
});

describe('faults are reported, never swallowed', () => {
  it('denied: a host that throws while building ops reports a local fault and the editor shows what the CRDT holds (the keystroke is undone)', async () => {
    const m = editor();
    type(m, 1, 'ab');
    m.host.failLocal = 'sync';
    type(m, 3, 'c');
    await tick();
    expect(m.faults).toEqual([{ kind: 'local', error: expect.objectContaining({ message: 'store is read-only' }) }]);
    expect(textOfPm(m.view.state.doc)).toBe('ab');
    expect(m.host.text()).toBe('ab');
    expect(m.view.state.selection.head).toBe(3);
  });

  it('denied: a host whose store rejects after applying reports a local fault; the text stays because the CRDT has it', async () => {
    const m = editor();
    type(m, 1, 'ab');
    m.host.failLocal = 'persist';
    type(m, 3, 'c');
    await tick();
    expect(m.faults).toEqual([{ kind: 'local', error: expect.objectContaining({ message: 'IndexedDB transaction aborted' }) }]);
    expect(textOfPm(m.view.state.doc)).toBe('abc');
    expect(m.host.text()).toBe('abc');
  });

  it('a mirror mismatch is reported with both texts, the steps and the cursor, then the editor is reset to the CRDT', () => {
    const m = editor();
    type(m, 1, 'ab');
    // Reach behind the plugin: a transaction the plugin cannot see as local (it carries a remote tag with a stale mirror).
    const stale = weftKey.getState(m.view.state)!;
    m.view.dispatch(m.view.state.tr.insertText('!', 3).setMeta('weft-remote', stale));
    expect(m.faults).toHaveLength(1);
    expect(m.faults[0]).toMatchObject({ kind: 'mirror', editor: 'ab!', crdt: 'ab', selection: { anchor: 4, head: 4 } });
    expect((m.faults[0] as Extract<BindingFault, { kind: 'mirror' }>).steps).toHaveLength(1);
    expect(textOfPm(m.view.state.doc)).toBe('ab');
    expect(pmPosToVisible(m.view.state.doc, m.view.state.selection.head)).toBe(2);
  });
});
