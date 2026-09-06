// @vitest-environment jsdom
// hardening.test.ts — the S3 hostile review's findings, each as the test that failed before its fix
// (00-GATES "S3 hardening"; LLD §11 E47–E51). Ops are minted by the plugin VIEW, never by
// `state.apply` alone; a block-type change is a `blk`, so a peer's concurrent keystroke into that
// block stays there; a remote batch with far-apart edits arrives as small per-block steps and a
// remote `blk` as one markup step, with the cursor kept; a join that would make a heading trailing
// keeps the heading; a composition that ends without `compositionend` still lets the deferred
// remote change through; a refused local edit never swallows the next real I7 fault; a cursor at
// index 0 sees a remote insert at 0 land after it; Enter continues a bullet or quote and ends an
// empty one.
import { visibleItems } from '@weft/crdt';
import { joinBackward, setBlockType, splitBlock } from 'prosemirror-commands';
import { TextSelection } from 'prosemirror-state';
import { afterEach, describe, expect, it } from 'vitest';
import { enterInListBlock } from '../../src/binding/keymap.ts';
import { weftKey } from '../../src/binding/plugin.ts';
import { schema } from '../../src/binding/schema.ts';
import { docChanges, exchange, expectMirror, expectSynced, hashOf, MemoryHost, mount, pasteText, R, textOfPm, tick, unmount, type Mounted } from './helpers.ts';

const mounted: Mounted[] = [];
function editor(host = new MemoryHost(R.a)): Mounted {
  const m = mount(host);
  mounted.push(m);
  return m;
}
afterEach(() => {
  for (const m of mounted.splice(0)) unmount(m);
});

const type = (m: Mounted, pos: number, text: string): void => m.view.dispatch(m.view.state.tr.insertText(text, pos));
const select = (m: Mounted, anchor: number, head = anchor): void => m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, anchor, head)));
const blockTypes = (m: Mounted): string[] => {
  const out: string[] = [];
  m.view.state.doc.forEach((b) => out.push(b.type.name + (b.type.name === 'heading' ? b.attrs.level : '')));
  return out;
};
const kinds = (m: Mounted, from: number): string[] => m.host.log.slice(from).map((op) => (op.t === 'ins' ? (op.content.kind === 'char' ? op.content.text : op.content.kind === 'break' ? '⏎' : `▮${op.content.attrs.type}`) : op.t));
const node = (name: string) => schema.nodes[name]!;
const pressEnter = (m: Mounted): void => {
  m.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
};
/** The PM position at the end of block `i`'s content. */
const endOf = (m: Mounted, i: number): number => {
  let pos = 0;
  for (let b = 0; b < i; b++) pos += m.view.state.doc.child(b).nodeSize;
  return pos + m.view.state.doc.child(i).nodeSize - 1;
};

describe('ops are minted by the view, not by state.apply', () => {
  it('state.apply(tr) without a dispatch emits no op; updateState with that state emits them', () => {
    const m = editor();
    type(m, 1, 'ab');
    const before = m.host.log.length;
    const next = m.view.state.apply(m.view.state.tr.insertText('c', 3));
    expect(m.host.log).toHaveLength(before);
    expect(weftKey.getState(next)?.unmirrored).toHaveLength(1);
    expect(weftKey.getState(next)?.doc).toBe(m.host.doc); // the mirror has not moved
    m.view.updateState(next);
    expect(m.host.log).toHaveLength(before + 1);
    expect(weftKey.getState(m.view.state)?.unmirrored).toHaveLength(0);
    expectSynced(m);
    expect(m.host.text()).toBe('abc');
  });
});

describe('a block-type change is a blk on the boundary register (finding 3)', () => {
  it('setBlockType on a non-trailing block is exactly one blk; a peer typing into that block concurrently keeps its character there and both converge', async () => {
    const a = editor(new MemoryHost(R.a));
    const b = editor(new MemoryHost(R.b));
    pasteText(a, 'head\nbody');
    await exchange(a.host, b.host);
    const n = a.host.log.length;
    select(a, 1);
    expect(setBlockType(node('heading'), { level: 2 })(a.view.state, a.view.dispatch)).toBe(true);
    expect(kinds(a, n)).toEqual(['blk']);
    type(b, 5, '!'); // end of "head", concurrently
    await exchange(a.host, b.host);
    await exchange(a.host, b.host);
    for (const m of [a, b]) {
      expectSynced(m);
      expect(blockTypes(m)).toEqual(['heading2', 'paragraph']);
      expect(textOfPm(m.view.state.doc)).toBe('head!\nbody');
    }
    expect(hashOf(a.host.doc)).toBe(hashOf(b.host.doc));
  });

  it('Enter at the start of a non-trailing heading is one boundary insert plus one blk, not three ops', () => {
    const m = editor();
    pasteText(m, 'x\ny');
    select(m, 1);
    setBlockType(node('heading'), { level: 1 })(m.view.state, m.view.dispatch);
    const n = m.host.log.length;
    select(m, 1);
    expect(splitBlock(m.view.state, m.view.dispatch)).toBe(true);
    expectSynced(m);
    expect(blockTypes(m)).toEqual(['paragraph', 'heading1', 'paragraph']);
    expect(kinds(m, n)).toEqual(['▮heading', 'blk']);
  });

  it('setBlockType over three blocks is three blks and no character is re-created', () => {
    const m = editor();
    pasteText(m, 'aa\nbb\ncc\ndd');
    const n = m.host.log.length;
    select(m, 1, 9);
    setBlockType(node('quote'))(m.view.state, m.view.dispatch);
    expectSynced(m);
    expect(kinds(m, n)).toEqual(['blk', 'blk', 'blk']);
    expect(blockTypes(m)).toEqual(['quote', 'quote', 'quote', 'paragraph']);
  });
});

describe('a remote change is the smallest edit that explains it (finding 6)', () => {
  it('two far-apart remote edits arrive as two small steps, and my cursor in an untouched block stays beside the same text', async () => {
    const a = editor(new MemoryHost(R.a));
    const b = editor(new MemoryHost(R.b));
    pasteText(a, 'one\ntwo\nthree\nfour\nfive');
    await exchange(a.host, b.host);
    select(a, 14); // "thr|ee"
    type(b, 1, 'X');
    type(b, b.view.state.doc.content.size - 1, 'Y');
    await exchange(a.host, b.host);
    expectSynced(a);
    expect(textOfPm(a.view.state.doc)).toBe('Xone\ntwo\nthree\nfour\nfiveY');
    const steps = docChanges(a).at(-1)!.steps.map((s) => s.toJSON() as { from: number; to: number });
    expect(steps).toHaveLength(2);
    for (const s of steps) expect(s.to - s.from).toBe(0); // inserts, not a replacement of everything between them
    expect(a.view.state.selection.head).toBe(15); // "thr|ee", shifted by the X in block 0
    expect(a.view.state.doc.textBetween(11, 15)).toBe('thr');
  });

  it('a remote blk on the block my cursor is in replaces that block’s markup only and keeps the cursor', async () => {
    const a = editor(new MemoryHost(R.a));
    const b = editor(new MemoryHost(R.b));
    pasteText(a, 'head\nbody');
    await exchange(a.host, b.host);
    select(a, 3); // "he|ad"
    select(b, 1);
    setBlockType(node('quote'))(b.view.state, b.view.dispatch);
    await exchange(a.host, b.host);
    expectSynced(a);
    expect(blockTypes(a)).toEqual(['quote', 'paragraph']);
    expect(a.view.state.selection.head).toBe(3);
    const steps = docChanges(a).at(-1)!.steps;
    expect(steps).toHaveLength(1);
    expect((steps[0]!.toJSON() as { stepType: string }).stepType).toBe('replaceAround'); // setNodeMarkup
  });

  it('a remote split in the middle block replaces that block alone', async () => {
    const a = editor(new MemoryHost(R.a));
    const b = editor(new MemoryHost(R.b));
    pasteText(a, 'aa\nbb\ncc');
    await exchange(a.host, b.host);
    select(b, 6); // "b|b": 0 <p 1 aa 3 p> 4 <p 5 b 6 b 7 p> 8
    splitBlock(b.view.state, b.view.dispatch);
    await exchange(a.host, b.host);
    expectSynced(a);
    expect(textOfPm(a.view.state.doc)).toBe('aa\nb\nb\ncc');
    const step = docChanges(a).at(-1)!.steps[0]!.toJSON() as { from: number; to: number };
    expect([step.from, step.to]).toEqual([4, 8]); // block "bb" only: positions 4..8
  });
});

describe('a join never silently demotes a heading (finding 7)', () => {
  it('Backspace at the start of the paragraph after a heading keeps the heading, closed by an explicit boundary, on both replicas — no correction of the text, no fault', async () => {
    const a = editor(new MemoryHost(R.a));
    const b = editor(new MemoryHost(R.b));
    pasteText(a, 'Title\nbody');
    select(a, 1);
    setBlockType(node('heading'), { level: 1 })(a.view.state, a.view.dispatch);
    await exchange(a.host, b.host);
    expect(blockTypes(b)).toEqual(['heading1', 'paragraph']);
    const n = a.host.log.length;
    select(a, a.view.state.doc.child(0).nodeSize + 1);
    expect(joinBackward(a.view.state, a.view.dispatch)).toBe(true);
    expectSynced(a);
    expect(a.faults).toEqual([]);
    expect(blockTypes(a)).toEqual(['heading1', 'paragraph']);
    expect(a.view.state.doc.child(0).textContent).toBe('Titlebody');
    // The heading's old boundary is deleted and a new one carrying its attrs closes it before ROOT, whose empty paragraph follows (E48).
    expect(kinds(a, n)).toEqual(['del', '▮heading']);
    expect(a.view.state.selection.head).toBe(6); // "Title|body"
    await exchange(a.host, b.host);
    expectSynced(b);
    expect(blockTypes(b)).toEqual(['heading1', 'paragraph']);
    expect(textOfPm(b.view.state.doc)).toBe('Titlebody\n');
    expect(hashOf(a.host.doc)).toBe(hashOf(b.host.doc));
  });

  it('Backspace in the empty paragraph after a trailing heading changes nothing: no op, no fault, the paragraph stays', async () => {
    const m = editor();
    pasteText(m, 'Title\nbody');
    select(m, 1);
    setBlockType(node('heading'), { level: 1 })(m.view.state, m.view.dispatch);
    select(m, m.view.state.doc.child(0).nodeSize + 1);
    joinBackward(m.view.state, m.view.dispatch);
    const n = m.host.log.length;
    select(m, m.view.state.doc.child(0).nodeSize + 1);
    joinBackward(m.view.state, m.view.dispatch);
    await tick();
    expectSynced(m);
    expect(m.host.log).toHaveLength(n);
    expect(m.faults).toEqual([]);
    expect(blockTypes(m)).toEqual(['heading1', 'paragraph']);
    expect(textOfPm(m.view.state.doc)).toBe('Titlebody\n');
  });

  it('a range deletion that merges a paragraph’s tail into the heading before it keeps the heading too', () => {
    const m = editor();
    pasteText(m, 'Title\nbody');
    select(m, 1);
    setBlockType(node('heading'), { level: 1 })(m.view.state, m.view.dispatch);
    m.view.dispatch(m.view.state.tr.deleteRange(4, 10)); // "Tit|le\nbo|dy" → "Titdy"
    expectSynced(m);
    expect(m.faults).toEqual([]);
    expect(blockTypes(m)).toEqual(['heading1', 'paragraph']);
    expect(m.view.state.doc.child(0).textContent).toBe('Titdy');
  });
});

describe('deferred remote changes are never stuck (finding 9)', () => {
  it('a composition that ends without compositionend still lets the deferred remote change through', async () => {
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
    (a.view as unknown as { input: { composing: boolean } }).input.composing = false; // the browser dropped the composition silently
    await tick();
    expectSynced(a);
    expect(textOfPm(a.view.state.doc)).toBe('abQ');
  });

  it('an editor update while no longer composing flushes the deferred change too', async () => {
    const a = editor(new MemoryHost(R.a));
    const b = editor(new MemoryHost(R.b));
    type(a, 1, 'ab');
    await exchange(a.host, b.host);
    a.view.dom.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    type(b, 3, 'Q');
    a.host.receive(b.host.pull());
    await tick();
    expect(textOfPm(a.view.state.doc)).toBe('ab');
    (a.view as unknown as { input: { composing: boolean } }).input.composing = false;
    select(a, 1); // any update
    await tick();
    expectSynced(a);
    expect(textOfPm(a.view.state.doc)).toBe('abQ');
  });
});

describe('a refused local edit does not swallow the next I7 fault (finding 10)', () => {
  it('after a host refuses a no-op replacement, a genuine mirror mismatch is still reported', async () => {
    const host = new MemoryHost(R.a);
    const m = editor(host);
    type(m, 1, 'ab');
    const local = host.local.bind(host);
    host.local = async () => {
      throw new Error('read-only');
    };
    m.view.dispatch(m.view.state.tr.replaceWith(1, 2, schema.text('a')));
    await tick();
    host.local = local;
    expect(m.faults.map((f) => f.kind)).toEqual(['local']);
    expect(textOfPm(m.view.state.doc)).toBe('ab');
    const stale = weftKey.getState(m.view.state)!;
    m.view.dispatch(m.view.state.tr.insertText('!', 3).setMeta('weft-remote', stale));
    expect(m.faults.map((f) => f.kind)).toEqual(['local', 'mirror']);
    expect(textOfPm(m.view.state.doc)).toBe('ab');
  });
});

describe('a cursor at index 0 is anchored after ROOT (finding 11)', () => {
  it('a remote insert at 0 lands after a cursor at 0, as a remote insert after "a" lands after a cursor after "a"', async () => {
    const a = editor(new MemoryHost(R.a));
    const b = editor(new MemoryHost(R.b));
    type(a, 1, 'ab');
    await exchange(a.host, b.host);
    select(a, 1);
    type(b, 1, 'ZZ');
    await exchange(a.host, b.host);
    expectSynced(a);
    expect(textOfPm(a.view.state.doc)).toBe('ZZab');
    expect(a.view.state.selection.head).toBe(1); // before ZZ
    select(a, 4); // "ZZa|b"
    type(b, 4, 'Q');
    await exchange(a.host, b.host);
    expect(textOfPm(a.view.state.doc)).toBe('ZZaQb');
    expect(a.view.state.selection.head).toBe(4); // before Q
  });
});

describe('Enter continues a bullet or quote and ends an empty one (finding 15)', () => {
  it('Enter at the end of a non-trailing bullet item makes another bullet item — one boundary op — and Enter in the empty one turns it into a paragraph — one blk', () => {
    const m = editor();
    pasteText(m, 'item\nnext');
    select(m, 1);
    setBlockType(node('bullet_item'))(m.view.state, m.view.dispatch);
    const n = m.host.log.length;
    select(m, 5);
    pressEnter(m); // through the view: the plugin's handleKeyDown runs before the base keymap
    expectSynced(m);
    expect(blockTypes(m)).toEqual(['bullet_item', 'bullet_item', 'paragraph']);
    expect(textOfPm(m.view.state.doc)).toBe('item\n\nnext');
    expect(kinds(m, n)).toEqual(['▮bullet']);
    pressEnter(m);
    expectSynced(m);
    expect(blockTypes(m)).toEqual(['bullet_item', 'paragraph', 'paragraph']);
    expect(kinds(m, n)).toEqual(['▮bullet', 'blk']);
    expect(m.faults).toEqual([]);
  });

  it('the same for a quote; a heading is not continued; mid-block Enter splits as before', () => {
    const m = editor();
    pasteText(m, 'quoted\nTitle\nnext');
    select(m, 1);
    setBlockType(node('quote'))(m.view.state, m.view.dispatch);
    select(m, 9);
    setBlockType(node('heading'), { level: 1 })(m.view.state, m.view.dispatch);
    select(m, 7); // end of "quoted"
    expect(enterInListBlock(m.view.state, m.view.dispatch)).toBe(true);
    expect(blockTypes(m)).toEqual(['quote', 'quote', 'heading1', 'paragraph']);
    select(m, 3); // "qu|oted"
    expect(enterInListBlock(m.view.state, m.view.dispatch)).toBe(true);
    expect(blockTypes(m)).toEqual(['quote', 'quote', 'quote', 'heading1', 'paragraph']);
    select(m, endOf(m, 3)); // end of "Title"
    expect(enterInListBlock(m.view.state, m.view.dispatch)).toBe(false);
    splitBlock(m.view.state, m.view.dispatch);
    expect(blockTypes(m)).toEqual(['quote', 'quote', 'quote', 'heading1', 'paragraph', 'paragraph']);
    expectSynced(m);
  });
});

describe('the production path (assert: false) checks the changed window, and still corrects what the alphabet lacks', () => {
  function prod(): Mounted {
    const m = mount(new MemoryHost(R.a), { assert: false });
    mounted.push(m);
    return m;
  }

  it('a multi-step transaction touching two blocks passes the window check and mirrors, with no fault', () => {
    const m = prod();
    pasteText(m, 'aa\nbb\ncc');
    // One transaction, three steps across three blocks: X into block 0, Y into block 2, and a
    // character out of block 1. Positions are in the transaction's own running document, so the
    // delete is 6..7 — the X inserted at 2 has already pushed block 1's first "b" from 5 to 6; 5..6
    // would be the block boundary, a no-op the schema heals. Multi-step and boundary-crossing, so it
    // takes the full reconcile, not the window fast path, and must still mirror with no fault.
    m.view.dispatch(m.view.state.tr.insertText('X', 2).insertText('Y', 10).delete(6, 7));
    expect(m.faults).toEqual([]);
    expectSynced(m); // the test's own full comparison
    expect(textOfPm(m.view.state.doc)).toBe('aXa\nb\nYcc');
  });

  it('pasted marks are shown then corrected away, and a pasted trailing heading is now KEPT — S6 owns the trailing block', () => {
    const m = prod();
    m.view.pasteHTML('<p>plain <b>bold</b></p><h1>Trailing</h1>', new Event('paste') as ClipboardEvent);
    expect(m.faults).toEqual([]);
    expectSynced(m);
    // Marks pasted as text are not stored (design §2.5): the editor shows the CRDT, which has none.
    expect(m.view.state.doc.rangeHasMark(0, m.view.state.doc.content.size, schema.marks.bold!)).toBe(false);
    // The trailing <h1> is kept, closed by an explicit boundary, with ROOT's empty paragraph after it (E5/E54).
    expect(blockTypes(m)).toEqual(['paragraph', 'heading1', 'paragraph']);
    expect(m.view.state.doc.child(1).textContent).toBe('Trailing');
    // Setting the last content block back to a heading level is a no-op here — it is already a heading;
    // set it to a paragraph instead and the boundary's register updates, no fault.
    select(m, m.view.state.doc.content.size - 2);
    setBlockType(node('paragraph'))(m.view.state, m.view.dispatch);
    expect(m.faults).toEqual([]);
    expectSynced(m);
  });

  it('a join into a heading and a refused edit behave as in development', async () => {
    const m = prod();
    pasteText(m, 'Title\nbody');
    select(m, 1);
    setBlockType(node('heading'), { level: 1 })(m.view.state, m.view.dispatch);
    select(m, m.view.state.doc.child(0).nodeSize + 1);
    joinBackward(m.view.state, m.view.dispatch);
    expect(m.faults).toEqual([]);
    expectSynced(m);
    expect(blockTypes(m)).toEqual(['heading1', 'paragraph']);
    expect(textOfPm(m.view.state.doc)).toBe('Titlebody\n');
    m.host.failLocal = 'sync';
    type(m, 2, 'Q');
    await tick();
    expect(m.faults.map((f) => f.kind)).toEqual(['local']);
    expect(textOfPm(m.view.state.doc)).toBe('Titlebody\n'); // the keystroke was undone
    m.host.failLocal = null;
    expectSynced(m);
  });
});

describe('the mirror property still holds over these shapes', () => {
  it('block-type changes, joins into headings and continued bullets interleaved with a peer’s edits converge', async () => {
    const a = editor(new MemoryHost(R.a));
    const b = editor(new MemoryHost(R.b));
    pasteText(a, 'one\ntwo\nthree');
    await exchange(a.host, b.host);
    select(a, 1);
    setBlockType(node('bullet_item'))(a.view.state, a.view.dispatch);
    select(b, 11);
    setBlockType(node('heading'), { level: 3 })(b.view.state, b.view.dispatch);
    type(b, 13, 'Z');
    await exchange(a.host, b.host);
    select(a, 4);
    pressEnter(a);
    select(b, 6);
    joinBackward(b.view.state, b.view.dispatch);
    await exchange(a.host, b.host);
    await exchange(a.host, b.host);
    for (const m of [a, b]) expectMirror(m);
    expect(hashOf(a.host.doc)).toBe(hashOf(b.host.doc));
    expect(textOfPm(a.view.state.doc)).toBe(textOfPm(b.view.state.doc));
    expect(visibleItems(a.host.doc).length).toBeGreaterThan(0);
  });
});
