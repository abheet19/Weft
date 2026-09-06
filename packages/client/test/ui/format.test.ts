// format.test.ts — the pure toolbar model (ui/format.ts): `activeFormat` reads the marks, block type,
// colours and checklist tick the selection carries, and the command builders run the same edits the
// keyboard shortcuts do. No DOM: an EditorState is enough, so the toolbar's pressed state and its
// commands are proven without rendering React (the rendered toolbar is covered by the Playwright S6
// flow).

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import { schema } from '../../src/binding/schema.ts';
import { activeFormat, setBlock, setColor, toggleMarkByName } from '../../src/ui/format.ts';

function docWith(block: string, text: string, marks: string[] = [], attrs: Record<string, unknown> | null = null): EditorState {
  const node = schema.node(block, attrs, text === '' ? [] : [schema.text(text, marks.map((m) => schema.marks[m]!.create()))]);
  return EditorState.create({ schema, doc: schema.node('doc', null, [node]) });
}

function select(state: EditorState, from: number, to: number): EditorState {
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
}

/** Run a command against a state and return the resulting state (or the same, if it declined). */
function run(state: EditorState, cmd: Command): EditorState {
  let next = state;
  cmd(state, (tr) => (next = state.apply(tr)));
  return next;
}

describe('activeFormat', () => {
  it('reports every boolean mark active across a selection', () => {
    const af = activeFormat(select(docWith('paragraph', 'word', ['bold', 'italic', 'underline', 'strikethrough', 'highlight', 'code']), 1, 5));
    expect(af).toMatchObject({ bold: true, italic: true, underline: true, strikethrough: true, highlight: true, code: true, link: false });
  });

  it('reports the block type and heading level', () => {
    expect(activeFormat(select(docWith('heading', 'Title', [], { level: 3 }), 1, 6)).block).toEqual({ type: 'heading', level: 3, checked: null });
  });

  it('reports a checklist item and its tick', () => {
    expect(activeFormat(select(docWith('check_item', 'todo', [], { checked: true }), 1, 5)).block).toEqual({ type: 'check_item', level: null, checked: true });
    expect(activeFormat(select(docWith('check_item', 'todo', [], { checked: false }), 1, 5)).block.checked).toBe(false);
  });

  it('reads a link href over the selection', () => {
    const base = docWith('paragraph', 'link', []);
    const withLink = base.apply(base.tr.addMark(1, 5, schema.marks.link!.create({ href: 'https://example.test/' })));
    const af = activeFormat(select(withLink, 1, 5));
    expect(af.link).toBe(true);
    expect(af.href).toBe('https://example.test/');
  });

  it('reads the text and highlight colours over the selection', () => {
    const base = docWith('paragraph', 'hue', []);
    const tr = base.tr.addMark(1, 4, schema.marks.textColor!.create({ color: '#0e8ea0' })).addMark(1, 4, schema.marks.highlightColor!.create({ color: '#ffe8a3' }));
    const af = activeFormat(select(base.apply(tr), 1, 4));
    expect(af.textColor).toBe('#0e8ea0');
    expect(af.highlightColor).toBe('#ffe8a3');
  });
});

describe('command builders', () => {
  it('toggleMarkByName adds and removes a boolean mark', () => {
    const on = run(select(docWith('paragraph', 'word'), 1, 5), toggleMarkByName('underline'));
    expect(on.doc.rangeHasMark(1, 5, schema.marks.underline!)).toBe(true);
    const off = run(select(on, 1, 5), toggleMarkByName('underline'));
    expect(off.doc.rangeHasMark(1, 5, schema.marks.underline!)).toBe(false);
  });

  it('setColor applies a colour and clears it', () => {
    const colored = run(select(docWith('paragraph', 'word'), 1, 5), setColor('textColor', '#7c5cf0'));
    expect(colored.doc.rangeHasMark(1, 5, schema.marks.textColor!)).toBe(true);
    const cleared = run(select(colored, 1, 5), setColor('textColor', null));
    expect(cleared.doc.rangeHasMark(1, 5, schema.marks.textColor!)).toBe(false);
  });

  it('setColor declines an empty selection', () => {
    const state = docWith('paragraph', 'word');
    expect(run(state, setColor('textColor', '#7c5cf0'))).toBe(state);
  });

  it('setBlock changes the block type to each new node', () => {
    for (const node of ['ordered_item', 'check_item', 'code_block', 'quote', 'bullet_item']) {
      const changed = run(select(docWith('paragraph', 'word'), 1, 5), setBlock(node));
      expect(changed.doc.firstChild?.type.name).toBe(node);
    }
  });
});
