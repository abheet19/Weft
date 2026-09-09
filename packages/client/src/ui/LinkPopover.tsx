// LinkPopover.tsx — the one floating element the redesign keeps (S6, 03-UI §4.4). It appears when the
// caret or selection sits inside a link and offers the four things you do with a link: Copy it (with a
// "Copied ✓" flash), Open it in a new tab (rel=noopener), Edit its href, or Remove the mark. It reads
// the link from the selection and positions itself under the link's start through the view's own
// coordinate map; in jsdom (no layout) the position is caught and the popover renders at its default
// spot, which the tests read. It dispatches only mark transactions the binding turns into `fmt` ops,
// and holds no document state.

import { useLayoutEffect, useRef, useState } from 'react';
import type { EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { isSafeHref } from '@weft/protocol';
import { safeHref, schema } from '../binding/schema.ts';
import { activeFormat } from './format.ts';
import { Icon } from './Icons.tsx';

interface LinkPopoverProps {
  view: EditorView;
  state: EditorState;
}

/** The character range of the link mark the selection's head sits in, so Remove/Edit act on the whole link, not just the selection. */
function linkRange(state: EditorState): { from: number; to: number } | null {
  const type = schema.marks.link!;
  const { $from } = state.selection;
  const mark = $from.marks().find((m) => m.type === type) ?? $from.nodeAfter?.marks.find((m) => m.type === type);
  if (mark === undefined) return null;
  let from = $from.pos;
  let to = $from.pos;
  const parent = $from.parent;
  const start = $from.start();
  parent.forEach((node, offset) => {
    if (node.isText && node.marks.some((m) => m.type === type && m.attrs.href === mark.attrs.href)) {
      const a = start + offset;
      const b = a + node.nodeSize;
      if (a <= $from.pos && $from.pos <= b) {
        from = Math.min(from, a);
        to = Math.max(to, b);
      }
    }
  });
  return from === to ? null : { from, to };
}

export function LinkPopover({ view, state }: LinkPopoverProps): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [href, setHref] = useState('');
  const [hrefError, setHrefError] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const af = activeFormat(state);
  const range = af.link ? linkRange(state) : null;
  const url = af.href ?? '';

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || range === null) return;
    try {
      const start = view.coordsAtPos(range.from);
      const wrap = el.offsetParent as HTMLElement | null;
      const box = wrap?.getBoundingClientRect();
      if (box !== undefined) {
        el.style.left = `${Math.max(0, start.left - box.left)}px`;
        el.style.top = `${Math.max(0, start.bottom - box.top + 6)}px`;
      }
    } catch {
      // No layout (jsdom): leave the default position.
    }
  }, [view, state, range]);

  const urlRef = useRef(url);
  urlRef.current = url;
  useLayoutEffect(() => {
    if (editing) {
      setHref(urlRef.current);
      setHrefError(false);
      input.current?.focus();
    }
  }, [editing]);

  if (range === null) return null;

  const copy = (): void => {
    void navigator.clipboard?.writeText(url).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };
  const open = (): void => {
    window.open(safeHref(url), '_blank', 'noopener');
  };
  const remove = (): void => {
    view.dispatch(view.state.tr.removeMark(range.from, range.to, schema.marks.link!));
    view.focus();
  };
  const saveEdit = (): void => {
    if (href !== '' && !isSafeHref(href)) {
      setHrefError(true);
      input.current?.focus();
      return;
    }
    if (href !== '') view.dispatch(view.state.tr.addMark(range.from, range.to, schema.marks.link!.create({ href })));
    setEditing(false);
    view.focus();
  };

  return (
    <div className="linkpop glass" role="dialog" aria-label="Link" ref={ref}>
      {editing ? (
        <>
          <input
            ref={input}
            className="tb-linkinput"
            type="url"
            aria-label="Edit link URL"
            aria-invalid={hrefError}
            aria-describedby={hrefError ? 'link-popover-error' : undefined}
            value={href}
            onChange={(e) => {
              setHref(e.target.value);
              setHrefError(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                saveEdit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setEditing(false);
                view.focus();
              }
            }}
          />
          {hrefError && (
            <span className="tb-linkerror linkpop-error" id="link-popover-error" role="alert">
              Use an http, https, or mailto URL.
            </span>
          )}
        </>
      ) : (
        <>
          <span className="url mono" title={url}>
            {url}
          </span>
          <button type="button" className={copied ? 'copied' : ''} aria-label={copied ? 'Copied' : 'Copy link'} onClick={copy}>
            <Icon name={copied ? 'check' : 'copy'} />
          </button>
          <button type="button" aria-label="Open link" onClick={open}>
            <Icon name="ext" />
          </button>
          <button type="button" aria-label="Edit link" onClick={() => setEditing(true)}>
            <Icon name="pen" />
          </button>
          <button type="button" aria-label="Remove link" onClick={remove}>
            <Icon name="trash" />
          </button>
        </>
      )}
    </div>
  );
}
