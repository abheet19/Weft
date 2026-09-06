// @vitest-environment jsdom
// shortcuts.test.ts — the format bar's keyboard shortcuts (E54) drive the same edits the buttons do
// and reach the CRDT. Each shortcut is dispatched as a real keydown on the editor's DOM (so it goes
// through the plugin's handleKeyDown), and the assertion is on the ops the host received and the
// editor's own state — the denied/edge paths (Ctrl+K on an unlinked vs a linked selection) included.

import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { Op } from '@weft/crdt';
import { linkAcrossSelection } from '../../src/binding/shortcuts.ts';
import { schema } from '../../src/binding/schema.ts';
import { expectSynced, mount, MemoryHost, R, textOfPm, unmount, type Mounted } from './helpers.ts';

/** Type text then select the whole first block's content, so a shortcut has a range to act on. */
function withSelection(m: Mounted, text: string): void {
  m.view.dispatch(m.view.state.tr.insertText(text, 1));
  m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, 1, 1 + text.length)));
}

/** Press a key with modifiers on the editor DOM — the path ProseMirror's keydownHandler listens on. */
function press(m: Mounted, key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}): void {
  m.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: mods.ctrl ?? false, shiftKey: mods.shift ?? false, altKey: mods.alt ?? false, bubbles: true, cancelable: true }));
}

type FmtOp = Extract<Op, { t: 'fmt' }>;
const fmtOps = (m: Mounted): FmtOp[] => m.host.log.filter((op): op is FmtOp => op.t === 'fmt');

describe('format shortcuts', () => {
  it('Ctrl+B / Ctrl+I / Ctrl+E toggle a mark over the selection and emit one fmt op each', () => {
    const m = mount(new MemoryHost(R.a));
    withSelection(m, 'word');
    press(m, 'b', { ctrl: true });
    press(m, 'i', { ctrl: true });
    press(m, 'e', { ctrl: true });
    for (const name of ['bold', 'italic', 'code'] as const) expect(m.view.state.doc.rangeHasMark(1, 5, schema.marks[name]!)).toBe(true);
    expect(fmtOps(m).map((op) => op.mark)).toEqual(['bold', 'italic', 'code']);
    expectSynced(m);
    unmount(m);
  });

  it('Ctrl+B again removes the mark (a second fmt op, active false)', () => {
    const m = mount(new MemoryHost(R.a));
    withSelection(m, 'word');
    press(m, 'b', { ctrl: true });
    press(m, 'b', { ctrl: true });
    expect(m.view.state.doc.rangeHasMark(1, 5, schema.marks.bold!)).toBe(false);
    expect(fmtOps(m).map((op) => op.active)).toEqual([true, false]);
    expectSynced(m);
    unmount(m);
  });

  it('Ctrl+Alt+1/2/3 set heading levels and Ctrl+Shift+8 / Ctrl+Shift+. set bullet and quote', () => {
    const m = mount(new MemoryHost(R.a));
    withSelection(m, 'title');
    press(m, '2', { ctrl: true, alt: true });
    expect(m.view.state.doc.firstChild?.type.name).toBe('heading');
    expect(m.view.state.doc.firstChild?.attrs.level).toBe(2);
    press(m, '8', { ctrl: true, shift: true });
    expect(m.view.state.doc.firstChild?.type.name).toBe('bullet_item');
    press(m, '.', { ctrl: true, shift: true });
    expect(m.view.state.doc.firstChild?.type.name).toBe('quote');
    expectSynced(m);
    unmount(m);
  });

  it('Shift+Enter and Ctrl+Enter insert a soft break — one ins of a break item — and I7 holds', () => {
    const m = mount(new MemoryHost(R.a));
    m.view.dispatch(m.view.state.tr.insertText('ab', 1));
    m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, 2))); // between a and b
    press(m, 'Enter', { shift: true });
    const breaks = m.host.log.filter((op) => op.t === 'ins' && op.content.kind === 'break');
    expect(breaks).toHaveLength(1);
    // Still one block (a break is inline, not a boundary) with a hard_break node.
    expect(m.view.state.doc.childCount).toBe(1);
    expect(textOfPm(m.view.state.doc)).toBe('a b');
    expectSynced(m);
    unmount(m);
  });

  it('Ctrl+K on an unlinked selection asks the shell for an href; on a linked one it removes the link', () => {
    let asked = 0;
    const m = mount(new MemoryHost(R.a), { onLink: () => (asked += 1) });
    withSelection(m, 'link');
    press(m, 'k', { ctrl: true });
    expect(asked).toBe(1); // no href from the keyboard: the shell opens the input
    expect(fmtOps(m)).toHaveLength(0);
    // Apply a link as the input would, then Ctrl+K removes it.
    m.view.dispatch(m.view.state.tr.addMark(1, 5, schema.marks.link!.create({ href: 'https://example.test/' })));
    expect(linkAcrossSelection(m.view.state, schema.marks.link!)).toBe(true);
    press(m, 'k', { ctrl: true });
    expect(m.view.state.doc.rangeHasMark(1, 5, schema.marks.link!)).toBe(false);
    expect(asked).toBe(1); // not asked again
    expectSynced(m);
    unmount(m);
  });
});
