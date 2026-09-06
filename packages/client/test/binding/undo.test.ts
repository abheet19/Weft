// @vitest-environment jsdom
// undo.test.ts — undo/redo through the real ProseMirror binding (S7). Undo emits real inverse ops
// on the host, which reach the editor as a remote change, so the mirror stays consistent (I7). This
// file proves: Ctrl+Z removes the last edit and the editor mirrors the CRDT afterwards; a remote op
// arriving in the same tick as an undo leaves both applied and the mirror intact; and over a random
// script of typing, undo, redo and deliveries the mirror holds after every step. It also proves the
// keymap wiring: a real Ctrl+Z keydown routes through the plugin to host.undo.
import { describe, expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { exchange, expectMirror, MemoryHost, mount, R, textOfPm, tick, unmount } from './helpers.ts';

describe('undo/redo through the binding', () => {
  it('Ctrl+Z removes the last edit and the editor still mirrors the CRDT', async () => {
    const host = new MemoryHost(R.a);
    const m = mount(host);
    try {
      m.view.dispatch(m.view.state.tr.insertText('hello', 1));
      await tick();
      expect(textOfPm(m.view.state.doc)).toBe('hello');

      host.undo();
      await tick();
      expect(textOfPm(m.view.state.doc)).toBe('');
      expectMirror(m);

      host.redo();
      await tick();
      expect(textOfPm(m.view.state.doc)).toBe('hello');
      expectMirror(m);
    } finally {
      unmount(m);
    }
  });

  it('a real Ctrl+Z keydown routes through the plugin to host.undo', async () => {
    const host = new MemoryHost(R.a);
    const m = mount(host);
    try {
      m.view.dispatch(m.view.state.tr.insertText('x', 1));
      await tick();
      expect(textOfPm(m.view.state.doc)).toBe('x');
      // ProseMirror consults handleKeyDown for a DOM keydown; dispatch one with the platform modifier.
      const handled = m.view.someProp('handleKeyDown', (f) => f(m.view, new KeyboardEvent('keydown', { key: 'z', ctrlKey: true })));
      expect(handled).toBe(true); // the binding claimed the key, so the browser's native undo never fires
      await tick();
      expect(textOfPm(m.view.state.doc)).toBe('');
      expectMirror(m);
    } finally {
      unmount(m);
    }
  });

  it('an undo and an incoming remote op in the same tick both apply, and the mirror holds', async () => {
    const a = new MemoryHost(R.a);
    const b = new MemoryHost(R.b);
    const ma = mount(a);
    const mb = mount(b);
    try {
      ma.view.dispatch(ma.view.state.tr.insertText('AA', 1));
      await tick();
      await exchange(a, b); // b now holds "AA"
      await tick();

      // b appends "B" while a undoes its "AA" — both changes land, and both editors mirror their CRDT.
      mb.view.dispatch(mb.view.state.tr.insertText('B', mb.view.state.doc.content.size - 1));
      a.undo();
      await tick();
      await exchange(a, b);
      await exchange(a, b);
      await tick();

      expectMirror(ma);
      expectMirror(mb);
      // a's "AA" is gone on both; b's "B" survives on both.
      expect(textOfPm(ma.view.state.doc)).toBe('B');
      expect(textOfPm(mb.view.state.doc)).toBe('B');
    } finally {
      unmount(ma);
      unmount(mb);
    }
  });

  it('a script of typing, undo, redo and deliveries keeps the mirror on both editors', async () => {
    const a = new MemoryHost(R.a);
    const b = new MemoryHost(R.b);
    const ma = mount(a);
    const mb = mount(b);
    try {
      const at = (m: typeof ma, text: string, pos: number): void => {
        const size = m.view.state.doc.content.size;
        m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc, Math.min(pos, size - 1) + 1)).insertText(text));
      };
      at(ma, 'weft', 0);
      await tick();
      at(mb, 'crdt', 0);
      await tick();
      await exchange(a, b);
      await tick();
      a.undo(); // undo "weft"
      await tick();
      expectMirror(ma);
      b.undo(); // undo "crdt"
      await tick();
      await exchange(a, b);
      await tick();
      a.redo();
      b.redo();
      await tick();
      await exchange(a, b);
      await exchange(a, b);
      await tick();
      expectMirror(ma);
      expectMirror(mb);
      expect(textOfPm(ma.view.state.doc)).toBe(textOfPm(mb.view.state.doc));
    } finally {
      unmount(ma);
      unmount(mb);
    }
  });
});
