// @vitest-environment jsdom
// FormatBar.test.tsx — the format bar reads the active marks and block type from the selection
// (the pure `activeFormat`, asserted directly) and renders them as pressed buttons; clicking a
// button runs the matching command against the editor. Rendered with react-dom into jsdom; the
// bar's own positioning (coordsAtPos) has no layout here and is caught, which is fine — the test
// reads the buttons, not their coordinates.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { afterEach, describe, expect, it } from 'vitest';
import { activeFormat, FormatBar } from '../../src/ui/FormatBar.tsx';
import { schema } from '../../src/binding/schema.ts';

function docWith(block: string, text: string, marks: string[] = [], attrs: Record<string, unknown> | null = null): EditorState {
  const node = schema.node(block, attrs, text === '' ? [] : [schema.text(text, marks.map((m) => schema.marks[m]!.create()))]);
  return EditorState.create({ schema, doc: schema.node('doc', null, [node]) });
}

function select(state: EditorState, from: number, to: number): EditorState {
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
}

describe('activeFormat', () => {
  it('reports the marks active across a selection', () => {
    const state = select(docWith('paragraph', 'word', ['bold', 'italic']), 1, 5);
    const af = activeFormat(state);
    expect(af).toMatchObject({ bold: true, italic: true, code: false, link: false });
    expect(af.block.type).toBe('paragraph');
  });

  it('reports the block type and heading level', () => {
    const af = activeFormat(select(docWith('heading', 'Title', [], { level: 3 }), 1, 6));
    expect(af.block).toEqual({ type: 'heading', level: 3 });
  });

  it('reads a link href over the selection', () => {
    const state = docWith('paragraph', 'link', []);
    const withLink = state.apply(state.tr.addMark(1, 5, schema.marks.link!.create({ href: 'https://example.test/' })));
    const af = activeFormat(select(withLink, 1, 5));
    expect(af.link).toBe(true);
    expect(af.href).toBe('https://example.test/');
  });
});

describe('FormatBar rendering', () => {
  let root: Root | null = null;
  let view: EditorView | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    view?.destroy();
    host?.remove();
    root = null;
    view = null;
    host = null;
  });

  function render(initial: EditorState): { button: (label: string) => HTMLButtonElement } {
    const mount = document.body.appendChild(document.createElement('div'));
    view = new EditorView(mount, { state: initial });
    host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
    act(() => root!.render(<FormatBar view={view!} state={view!.state} linkOpen={false} setLinkOpen={() => {}} />));
    return {
      button: (label) => {
        const el = host!.querySelector<HTMLButtonElement>(`button[aria-label^="${label}"]`);
        if (el === null) throw new Error(`no button ${label}`);
        return el;
      },
    };
  }

  it('shows the Bold button pressed when the selection is bold, and Italic not pressed', () => {
    const { button } = render(select(docWith('paragraph', 'word', ['bold']), 1, 5));
    expect(button('Bold').getAttribute('aria-pressed')).toBe('true');
    expect(button('Italic').getAttribute('aria-pressed')).toBe('false');
  });

  it('shows the H2 button pressed for a level-2 heading selection', () => {
    const { button } = render(select(docWith('heading', 'Title', [], { level: 2 }), 1, 6));
    expect(button('Heading 2').getAttribute('aria-pressed')).toBe('true');
    expect(button('Paragraph').getAttribute('aria-pressed')).toBe('false');
  });

  it('applies bold to the editor when the Bold button is clicked', () => {
    const { button } = render(select(docWith('paragraph', 'word'), 1, 5));
    act(() => button('Bold').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(view!.state.doc.rangeHasMark(1, 5, schema.marks.bold!)).toBe(true);
  });
});
