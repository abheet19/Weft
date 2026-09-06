// Editor.tsx — one ProseMirror view bound to one session's host, plus the persistent formatting
// toolbar and the link popover (S6), the peers' remote carets (S5) and follow mode (S5). It also
// builds the sidebar's outline from the doc's headings and toggles a checklist item's collaborative
// tick from a click on its box. This component mounts the view and, on every
// transaction, reports the local caret to the runner as item anchors so peers can draw it; it never
// owns sync logic. Follow mode frames the page in the followed peer's hue and scrolls their caret
// into view, and ANY local keystroke, pointer press or scroll exits it (03-UI §4.2/§4.6) — following
// is a glance, never a mode you get stuck in. Session start, faults and the page's states live in
// the shell; an editor is mounted only once the document is loaded.

import { useEffect, useRef, useState } from 'react';
import { baseKeymap } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import type { Node as PMNode } from 'prosemirror-model';
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
import { LinkPopover } from './LinkPopover.tsx';
import { RemoteCarets } from './RemoteCarets.tsx';
import { Toolbar } from './Toolbar.tsx';
import type { OutlineItem } from './Sidebar.tsx';

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
  /** The document's headings after each change (deduped), for the sidebar's Outline tab. */
  onOutline?: (outline: readonly OutlineItem[]) => void;
}

/** The headings of the doc in order, each with the PM position of its start (for the outline to jump to). */
function outlineOf(doc: PMNode): OutlineItem[] {
  const items: OutlineItem[] = [];
  let pos = 0;
  doc.forEach((block) => {
    if (block.type.name === 'heading') items.push({ level: (block.attrs.level as number | undefined) ?? 1, text: block.textContent, pos: pos + 1 });
    pos += block.nodeSize;
  });
  return items;
}

/** Words in the document — its text content split on whitespace. */
function wordCount(doc: PMNode): number {
  const text = doc.textContent.trim();
  return text === '' ? 0 : text.split(/\s+/).length;
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

export function Editor({ host, onFault, peers, reportCursor, follow, onExitFollow, onView, onOutline }: EditorProps): React.JSX.Element {
  const mount = useRef<HTMLElement>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const [state, setState] = useState<EditorState | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [words, setWords] = useState(0);
  const report = useRef(reportCursor);
  report.current = reportCursor;
  const publishView = useRef(onView);
  publishView.current = onView;
  const outline = useRef(onOutline);
  outline.current = onOutline;
  const lastOutline = useRef('');

  useEffect(() => {
    if (mount.current === null) return undefined;
    const pushOutline = (doc: PMNode): void => {
      const items = outlineOf(doc);
      const key = JSON.stringify(items);
      if (key === lastOutline.current) return; // headings unchanged: no shell re-render on every keystroke
      lastOutline.current = key;
      outline.current?.(items);
    };
    const initial = EditorState.create({ schema, doc: normalize(visibleItems(host.doc)), plugins: [weftPlugin({ host, onFault, onLink: () => setLinkOpen(true) }), keymap(baseKeymap)] });
    const editor = new EditorView(mount.current, {
      state: initial,
      // Toggling a checklist item's tick: a click in the item's leading checkbox box (its first ~30px)
      // flips `checked` through a setNodeMarkup the binding turns into one `blk` op — a collaborative,
      // mergeable edit, not a local DOM flag.
      handleClickOn(v, _pos, node, nodePos, event) {
        if (node.type.name !== 'check_item' || !(event.target instanceof Element)) return false;
        const li = event.target.closest('li[data-check]');
        if (li === null || event.clientX >= li.getBoundingClientRect().left + 30) return false;
        v.dispatch(v.state.tr.setNodeMarkup(nodePos, undefined, { checked: node.attrs.checked !== true }));
        return true;
      },
      dispatchTransaction(tr) {
        const next = editor.state.apply(tr);
        editor.updateState(next);
        setState(next);
        if (tr.selection.empty) setLinkOpen(false);
        if (tr.docChanged) setWords(wordCount(next.doc));
        pushOutline(next.doc);
        report.current(cursorOf(host, editor));
      },
    });
    setWords(wordCount(initial.doc));
    pushOutline(initial.doc);
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
      {view !== null && state !== null && <Toolbar view={view} state={state} linkOpen={linkOpen} setLinkOpen={setLinkOpen} undo={host.undo} redo={host.redo} />}
      {follow !== null && (
        <div className="follow-tag" style={style}>
          Following <b>{peers.get(follow)?.state.name ?? 'peer'}</b> · any key or scroll exits
        </div>
      )}
      <article className="doc" ref={mount} />
      {view !== null && state !== null && <LinkPopover view={view} state={state} />}
      {view !== null && <RemoteCarets view={view} doc={host.doc} peers={peers} />}
      <div className="pagefoot">
        <span>
          {words} word{words === 1 ? '' : 's'}
        </span>
        <span aria-hidden="true">·</span>
        <span>Fugue CRDT</span>
      </div>
    </div>
  );
}
