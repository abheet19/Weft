// FormatBar.tsx — the floating format bar of 03-UI §4.4, ported from the prototype's L2 glass bar
// (markup and CSS, E55). It appears over a non-empty selection and shows, for the current
// selection, which marks and which block type are active — read by the pure `activeFormat`, which
// is what the component test asserts. Every button runs the same prosemirror-commands the keyboard
// shortcuts do (shortcuts.ts), so the bar and the keys are one edit; a click uses `mousedown` with
// preventDefault so the selection the command needs is not lost to focus. Link needs an href the
// bar collects in a small inline input (no dependency). It must hold no editing logic of its own —
// only read state and dispatch commands — and never store document state.

import { useLayoutEffect, useRef, useState } from 'react';
import { setBlockType, toggleMark } from 'prosemirror-commands';
import type { Command, EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { schema } from '../binding/schema.ts';
import { linkAcrossSelection } from '../binding/shortcuts.ts';
import { Icon } from './Icons.tsx';

/** The active marks and block type of the current selection — a pure read, so the bar's pressed state is testable without React. */
export interface ActiveFormat {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly code: boolean;
  readonly link: boolean;
  readonly block: { readonly type: string; readonly level: number | null };
  /** The link href over the selection, if it carries one — pre-fills the input when editing a link. */
  readonly href: string | null;
}

export function activeFormat(state: EditorState): ActiveFormat {
  const { from, to, empty, $from } = state.selection;
  const has = (name: 'bold' | 'italic' | 'code' | 'link'): boolean => {
    const type = schema.marks[name]!;
    if (empty) return (state.storedMarks ?? $from.marks()).some((m) => m.type === type);
    return state.doc.rangeHasMark(from, to, type);
  };
  const link = schema.marks.link!;
  let href: string | null = (empty ? $from.marks() : []).find((m) => m.type === link)?.attrs.href ?? null;
  if (!empty) state.doc.nodesBetween(from, to, (node) => {
    if (href === null) href = (node.marks.find((m) => m.type === link)?.attrs.href as string | undefined) ?? null;
  });
  const block = $from.parent;
  return {
    bold: has('bold'),
    italic: has('italic'),
    code: has('code'),
    link: has('link'),
    block: { type: block.type.name, level: (block.attrs.level as number | undefined) ?? null },
    href,
  };
}

interface FormatBarProps {
  view: EditorView;
  state: EditorState;
  /** True while the link input is open (Ctrl+K on an unlinked selection, or the 🔗 button). */
  linkOpen: boolean;
  setLinkOpen: (open: boolean) => void;
}

export function FormatBar({ view, state, linkOpen, setLinkOpen }: FormatBarProps): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [href, setHref] = useState('');
  const sel = state.selection;
  const af = activeFormat(state);
  const visible = !sel.empty;

  // Float the bar above the selection, within the editor's positioned wrapper. In jsdom (the
  // component test) coordsAtPos has no layout and throws; the bar then renders at its default
  // position, which is all the test reads.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || !visible) return;
    try {
      const start = view.coordsAtPos(sel.from);
      const wrap = el.offsetParent as HTMLElement | null;
      const box = wrap?.getBoundingClientRect();
      if (box !== undefined) {
        el.style.left = `${Math.max(0, start.left - box.left)}px`;
        el.style.top = `${Math.max(0, start.top - box.top - el.offsetHeight - 8)}px`;
      }
    } catch {
      // No layout (jsdom): leave the default position.
    }
  }, [view, sel, visible]);

  // When the input opens, seed it with the selection's current href and focus it. Depends only on
  // the open flag; the href is read at that instant (a ref would over-fire on every selection change).
  const hrefRef = useRef(af.href);
  hrefRef.current = af.href;
  useLayoutEffect(() => {
    if (linkOpen) {
      setHref(hrefRef.current ?? '');
      input.current?.focus();
    }
  }, [linkOpen]);

  if (!visible) return null;

  const run = (cmd: Command): void => {
    cmd(view.state, view.dispatch);
    view.focus();
  };
  const stop = (e: React.MouseEvent): void => e.preventDefault();

  const linkButton = (): void => {
    const type = schema.marks.link!;
    if (linkAcrossSelection(view.state, type)) {
      view.dispatch(view.state.tr.removeMark(view.state.selection.from, view.state.selection.to, type));
      view.focus();
    } else setLinkOpen(true);
  };

  const applyLink = (): void => {
    const type = schema.marks.link!;
    const { from, to } = view.state.selection;
    if (href !== '' && from !== to) view.dispatch(view.state.tr.addMark(from, to, type.create({ href })));
    setLinkOpen(false);
    view.focus();
  };

  const setBlock = (type: string, attrs: Record<string, unknown> | null = null): void => run(setBlockType(schema.nodes[type]!, attrs));

  return (
    <div className="fmt glass" role="toolbar" aria-label="Formatting" ref={ref}>
      <button aria-pressed={af.bold} aria-label="Bold (Ctrl+B)" onMouseDown={stop} onClick={() => run(toggleMark(schema.marks.bold!))}>
        <b>B</b>
      </button>
      <button aria-pressed={af.italic} aria-label="Italic (Ctrl+I)" onMouseDown={stop} onClick={() => run(toggleMark(schema.marks.italic!))}>
        <i>I</i>
      </button>
      <button aria-pressed={af.code} aria-label="Code (Ctrl+E)" onMouseDown={stop} onClick={() => run(toggleMark(schema.marks.code!))}>
        <Icon name="code" />
      </button>
      <button aria-pressed={af.link} aria-label="Link (Ctrl+K)" onMouseDown={stop} onClick={linkButton}>
        <Icon name="link" />
      </button>
      {linkOpen && (
        <input
          ref={input}
          className="fmt-link"
          type="url"
          placeholder="https://…"
          aria-label="Link URL"
          value={href}
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => setHref(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              applyLink();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setLinkOpen(false);
              view.focus();
            }
          }}
        />
      )}
      <span className="sep" />
      <button aria-pressed={af.block.type === 'paragraph'} aria-label="Paragraph" onMouseDown={stop} onClick={() => setBlock('paragraph')}>
        ¶
      </button>
      {([1, 2, 3] as const).map((level) => (
        <button key={level} aria-pressed={af.block.type === 'heading' && af.block.level === level} aria-label={`Heading ${level} (Ctrl+Alt+${level})`} onMouseDown={stop} onClick={() => setBlock('heading', { level })}>
          H{level}
        </button>
      ))}
      <button aria-pressed={af.block.type === 'bullet_item'} aria-label="Bullet list" onMouseDown={stop} onClick={() => setBlock('bullet_item')}>
        <Icon name="list" />
      </button>
      <button aria-pressed={af.block.type === 'quote'} aria-label="Quote" onMouseDown={stop} onClick={() => setBlock('quote')}>
        <Icon name="quote" />
      </button>
    </div>
  );
}
