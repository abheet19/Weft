// RemoteCarets.tsx — the peers' carets and selections drawn over the editor page (03-UI §4.3),
// ported from the prototype's `.rcaret` / `.rsel` markup and CSS. Each caret is a 2px bar in the
// peer's hue with a name flag that shows for 1.5s after a move and on hover, fades to 40% after 30s
// idle, and vanishes when the peer times out. A caret is an ItemAnchor, so it is resolved through
// the live PositionIndex every render: it stays beside the right character as text is inserted or
// deleted, and a caret whose anchor names an item this replica has not received is hidden, never
// dropped to the document start (LLD §8 S5). This component only reads — the view, the document and
// the peer table — and paints; it never dispatches an edit. Positioning uses `coordsAtPos`, which
// has no layout in jsdom (so this file is exercised only by the browser e2e); every read is guarded.

import { useEffect, useMemo, useState } from 'react';
import { buildIndex, type Doc } from '@weft/crdt';
import type { EditorView } from 'prosemirror-view';
import { anchorVisibleOrHidden, visibleToPmPos } from '../binding/positions.ts';
import { caretViews, type PeerTable } from '../presence/awareness.ts';
import { hueVar } from '../presence/colors.ts';

interface RemoteCaretsProps {
  view: EditorView;
  doc: Doc;
  peers: PeerTable;
}

interface Placed {
  readonly replica: string;
  readonly name: string;
  readonly hue: string;
  readonly flag: boolean;
  readonly idle: boolean;
  readonly caret: { left: number; top: number; height: number };
  readonly selection: readonly { left: number; top: number; width: number; height: number }[];
}

/** The wrap-relative rectangle of a visible index, or null when it has no layout (jsdom) or is out of range. */
function rectAt(view: EditorView, wrap: DOMRect, doc: Doc, visible: number): { left: number; top: number; height: number } | null {
  try {
    const coords = view.coordsAtPos(visibleToPmPos(view.state.doc, visible));
    return { left: coords.left - wrap.left, top: coords.top - wrap.top, height: coords.bottom - coords.top };
  } catch {
    return null;
  }
}

export function RemoteCarets({ view, doc, peers }: RemoteCaretsProps): React.JSX.Element {
  // A slow tick advances the flag (1.5s) and idle (30s) transitions and re-lays-out after a scroll
  // or resize; the doc and peers already re-render this component when they change.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const bump = (): void => setNow(Date.now());
    const timer = setInterval(bump, 500);
    const scroller = view.dom.parentElement;
    scroller?.addEventListener('scroll', bump, { passive: true });
    window.addEventListener('resize', bump);
    return () => {
      clearInterval(timer);
      scroller?.removeEventListener('scroll', bump);
      window.removeEventListener('resize', bump);
    };
  }, [view]);

  const index = useMemo(() => buildIndex(doc), [doc]);
  const placed = useMemo((): readonly Placed[] => {
    const wrap = view.dom.getBoundingClientRect();
    const out: Placed[] = [];
    for (const c of caretViews(peers, now)) {
      const head = anchorVisibleOrHidden(index, c.cursor.head);
      if (head === null) continue; // anchored to an item we do not hold: hidden, not at index 0
      const caret = rectAt(view, wrap, doc, head);
      if (caret === null) continue;
      const anchor = anchorVisibleOrHidden(index, c.cursor.anchor);
      const selection = anchor === null || anchor === head ? [] : selectionRects(view, wrap, doc, Math.min(anchor, head), Math.max(anchor, head));
      out.push({ replica: c.replica, name: c.name, hue: hueVar(c.color), flag: c.flag, idle: c.idle, caret, selection });
    }
    return out;
    // `now` drives the recompute; index/doc/peers/view are the inputs.
  }, [view, doc, peers, index, now]);

  return (
    <>
      {placed.map((p) => (
        <span key={p.replica}>
          {p.selection.map((r, i) => (
            <span key={i} className="rsel-box" aria-hidden="true" style={{ ['--hue' as string]: p.hue, left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` }} />
          ))}
          <span className={`rcaret${p.flag ? ' moved' : ''}${p.idle ? ' idle' : ''}`} aria-hidden="true" style={{ ['--hue' as string]: p.hue, left: `${p.caret.left}px`, top: `${p.caret.top}px`, height: `${p.caret.height}px` }}>
            <span className="flag">{p.name}</span>
          </span>
        </span>
      ))}
    </>
  );
}

/** Best-effort selection boxes: one rect per line the range covers, from the left of `from` to the right of `to` on each. A range with no layout contributes nothing. */
function selectionRects(view: EditorView, wrap: DOMRect, doc: Doc, from: number, to: number): readonly { left: number; top: number; width: number; height: number }[] {
  const a = rectAt(view, wrap, doc, from);
  const b = rectAt(view, wrap, doc, to);
  if (a === null || b === null) return [];
  if (Math.abs(a.top - b.top) < 1) return [{ left: a.left, top: a.top, width: Math.max(0, b.left - a.left), height: a.height }];
  // Multi-line: a box from `from` to the page's right edge, and one from the left to `to`. The middle
  // lines are left unpainted rather than guessed — the caret, which the demo points at, is exact.
  const right = wrap.width;
  return [
    { left: a.left, top: a.top, width: Math.max(0, right - a.left), height: a.height },
    { left: 0, top: b.top, width: b.left, height: b.height },
  ];
}
