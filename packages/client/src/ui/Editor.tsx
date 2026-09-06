// Editor.tsx — one ProseMirror view bound to one session's host, plus the floating format bar (S6),
// the peers' remote carets (S5) and follow mode (S5). This component mounts the view and, on every
// transaction, reports the local caret to the runner as item anchors so peers can draw it; it never
// owns sync logic. Follow mode frames the page in the followed peer's hue and scrolls their caret
// into view, and ANY local keystroke, pointer press or scroll exits it (03-UI §4.2/§4.6) — following
// is a glance, never a mode you get stuck in. Session start, faults and the page's states live in
// the shell; an editor is mounted only once the document is loaded.

import { useEffect, useRef, useState } from 'react';
import { baseKeymap } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { buildIndex, visibleItems, type ReplicaId } from '@weft/crdt';
import type { ItemAnchor, PresenceState } from '@weft/protocol';
import { normalize } from '../binding/normalize.ts';
import { weftPlugin, type BindingFault, type BindingHost } from '../binding/plugin.ts';
import { anchorFromVisible, anchorVisibleOrHidden, pmPosToVisible, visibleToPmPos } from '../binding/positions.ts';
import { schema } from '../binding/schema.ts';
import { hueVar } from '../presence/colors.ts';
import type { PeerTable } from '../presence/awareness.ts';
import { FormatBar } from './FormatBar.tsx';
import { RemoteCarets } from './RemoteCarets.tsx';

interface EditorProps {
  host: BindingHost;
  onFault: (fault: BindingFault) => void;
  peers: PeerTable;
  /** The local caret as item anchors after every transaction; undefined when there is no selection. */
  reportCursor: (cursor: PresenceState['cursor']) => void;
  follow: ReplicaId | null;
  onExitFollow: () => void;
  /** Hands the live view to the shell (null on unmount) so a shell action — the ⌘K "Rename via heading" — can focus the editor at the title. */
  onView?: (view: EditorView | null) => void;
}

/** The local selection as item anchors, resolved against the CRDT's PositionIndex (I7 keeps the PM doc and the CRDT in step). */
function cursorOf(host: BindingHost, view: EditorView): PresenceState['cursor'] {
  try {
    const index = buildIndex(host.doc);
    const anchor: ItemAnchor = anchorFromVisible(index, pmPosToVisible(view.state.doc, view.state.selection.anchor));
    const head: ItemAnchor = anchorFromVisible(index, pmPosToVisible(view.state.doc, view.state.selection.head));
    return { anchor, head };
  } catch {
    return undefined;
  }
}

export function Editor({ host, onFault, peers, reportCursor, follow, onExitFollow, onView }: EditorProps): React.JSX.Element {
  const mount = useRef<HTMLElement>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const [state, setState] = useState<EditorState | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const report = useRef(reportCursor);
  report.current = reportCursor;
  const publishView = useRef(onView);
  publishView.current = onView;

  useEffect(() => {
    if (mount.current === null) return undefined;
    const initial = EditorState.create({ schema, doc: normalize(visibleItems(host.doc)), plugins: [weftPlugin({ host, onFault, onLink: () => setLinkOpen(true) }), keymap(baseKeymap)] });
    const editor = new EditorView(mount.current, {
      state: initial,
      dispatchTransaction(tr) {
        const next = editor.state.apply(tr);
        editor.updateState(next);
        setState(next);
        if (tr.selection.empty) setLinkOpen(false);
        report.current(cursorOf(host, editor));
      },
    });
    setView(editor);
    setState(editor.state);
    report.current(cursorOf(host, editor));
    publishView.current?.(editor);
    return () => {
      publishView.current?.(null);
      editor.destroy();
      setView(null);
      setState(null);
      setLinkOpen(false);
    };
  }, [host, onFault]);

  // Follow mode: any local keystroke, pointer press or scroll is a signal the user took the wheel —
  // exit at once (03-UI §4.6). The frame and the scroll-into-view are applied below.
  useEffect(() => {
    if (follow === null || view === null) return undefined;
    const exit = (): void => onExitFollow();
    view.dom.addEventListener('keydown', exit);
    view.dom.addEventListener('mousedown', exit);
    window.addEventListener('wheel', exit, { passive: true });
    return () => {
      view.dom.removeEventListener('keydown', exit);
      view.dom.removeEventListener('mousedown', exit);
      window.removeEventListener('wheel', exit);
    };
  }, [follow, view, onExitFollow]);

  // Track the followed peer's caret into view as it moves.
  useEffect(() => {
    if (follow === null || view === null) return;
    const cursor = peers.get(follow)?.state.cursor;
    if (cursor === undefined) return;
    const visible = anchorVisibleOrHidden(buildIndex(host.doc), cursor.head);
    if (visible === null) return;
    try {
      const coords = view.coordsAtPos(visibleToPmPos(view.state.doc, visible));
      view.dom.parentElement?.scrollTo({ top: view.dom.parentElement.scrollTop + coords.top - view.dom.getBoundingClientRect().top - 120, behavior: 'smooth' });
    } catch {
      // No layout: nothing to scroll to.
    }
  }, [follow, view, peers, host]);

  const followHue = follow === null ? null : hueVar(peers.get(follow)?.state.color ?? 0);
  const style = followHue === null ? undefined : ({ ['--follow' as string]: followHue } as React.CSSProperties);

  return (
    <div className={`editor-wrap${follow === null ? '' : ' following'}`} style={style}>
      {follow !== null && (
        <div className="follow-tag" style={style}>
          Following <b>{peers.get(follow)?.state.name ?? 'peer'}</b> · any key or scroll exits
        </div>
      )}
      <article className="doc" ref={mount} />
      {view !== null && state !== null && <FormatBar view={view} state={state} linkOpen={linkOpen} setLinkOpen={setLinkOpen} />}
      {view !== null && <RemoteCarets view={view} doc={host.doc} peers={peers} />}
    </div>
  );
}
