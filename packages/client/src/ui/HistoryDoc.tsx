// HistoryDoc.tsx — the paper while time-travelling: a READ-ONLY rendering of the document at a
// slider position (03-UI §4.6). It replaces the live editor whenever the History slider is off the
// end, so the user can scrub through `fold(apply, openedDocument, sessionOps[0..n])` without editing the past — editing
// resumes the instant the slider returns to the end, when the shell mounts the live Editor again.
// The optional "Show authors" overlay tints each character in its author replica's hue (the same
// palette the presence carets use), so the audience can see who wrote what across the whole history.
// It owns no sync logic and never emits an op — a historical document is a value to look at, not to
// change.

import { useEffect, useRef } from 'react';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view';
import { visibleItems, type Doc, type Op } from '@weft/crdt';
import { normalize } from '../binding/normalize.ts';
import { visibleToPmPos } from '../binding/positions.ts';
import { schema } from '../binding/schema.ts';
import { replayTo } from '../history/timeTravel.ts';
import { colorOf, hueVar } from '../presence/colors.ts';

interface HistoryDocProps {
  base: Doc;
  ops: readonly Op[];
  position: number;
  showAuthors: boolean;
}

/** One inline decoration per visible character/break, coloured by its author replica's hue. Boundaries carry no colour (they are structure, not text). */
function authorDecorations(doc: Doc, pmDoc: PMNode): DecorationSet {
  const items = visibleItems(doc);
  const decos: Decoration[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === undefined || item.content.kind === 'block') continue;
    const units = item.content.kind === 'char' ? item.content.text.length : 1; // a surrogate pair is two UTF-16 units
    try {
      const from = visibleToPmPos(pmDoc, i);
      decos.push(Decoration.inline(from, from + units, { style: `color:${hueVar(colorOf(item.id.replica))}` }));
    } catch {
      // A position the read-only doc cannot map (should not happen for a normalised doc): skip that item's tint.
    }
  }
  return DecorationSet.create(pmDoc, decos);
}

export function HistoryDoc({ base, ops, position, showAuthors }: HistoryDocProps): React.JSX.Element {
  const mount = useRef<HTMLElement>(null);
  const view = useRef<EditorView | null>(null);

  useEffect(() => {
    if (mount.current === null) return undefined;
    const editor = new EditorView(mount.current, {
      editable: () => false, // the past is read-only; editing resumes when the slider returns to the end
      state: EditorState.create({ schema, doc: normalize(visibleItems(base)) }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [base]);

  // Re-render the replayed document on every scrub and whenever the overlay toggles.
  useEffect(() => {
    const editor = view.current;
    if (editor === null) return;
    const doc = replayTo(base, ops, position);
    const pmDoc = normalize(visibleItems(doc));
    editor.updateState(EditorState.create({ schema, doc: pmDoc }));
    editor.setProps({ decorations: (state) => (showAuthors ? authorDecorations(doc, state.doc) : DecorationSet.empty) });
  }, [base, ops, position, showAuthors]);

  return <article className={`doc history${showAuthors ? ' authors' : ''}`} ref={mount} aria-readonly="true" />;
}
